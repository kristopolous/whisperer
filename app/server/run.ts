/** Run every stage of a scan, and decide honestly what happened.
 *
 *  Extracted from the HTTP handler so that a scheduled run and a run somebody
 *  is watching are the same code. They were about to be two implementations of
 *  "run the pipeline", which is how a nightly job quietly stops matching the
 *  thing it is supposed to automate.
 *
 *  Everything it reports goes through `send`. A watched run wires that to the
 *  event stream; a scheduled one drops the events on the floor and reads the
 *  finished record afterwards, which is the only difference between them.
 */

import type { Scan, ScanEvent, Stage } from '../shared/types.ts';
import { STAGES } from '../shared/types.ts';
import { runStage, explainFailure } from './stages.ts';
import type { Log } from './pipeline.ts';
import { wasCancelled } from './run-context.ts';
import { describeError } from './errors.ts';
import { availableConnectors } from './mcp.ts';
import { resetSearchBudget, searchSpend } from './search.ts';
import * as store from './store.ts';

const STAGE_KEYS: Stage[] = STAGES.map((s) => s.key);

/** The stages this particular run should perform, in order.
 *
 *  Almost always the canonical order, which ends with the footprint crawl
 *  because it is static and the reason to run daily is everything before it.
 *
 *  The exception is a scan that has never mapped a footprint. The subreddit and
 *  GitHub org that crawl finds turn into much sharper discovery queries — the
 *  difference between `site:reddit.com Bolt.new` and querying r/boltnewbuilders
 *  directly — so on a first run it is worth waiting for, and on every run after
 *  it is worth deferring. */
export function stagesFor(scan: Scan): Stage[] {
  if ((scan.profiles?.length ?? 0) > 0) return STAGE_KEYS;
  const rest = STAGE_KEYS.filter((key) => key !== 'subject' && key !== 'presence');
  return ['subject', 'presence', ...rest];
}

/** Run the whole pipeline over `scan`, mutating and persisting it as it goes.
 *
 *  Never throws for an ordinary stage failure: a stage that dies is recorded on
 *  the scan and the run continues, because one dead connector must not throw
 *  away five good stages. The return value says how it ended. */
export async function performScan(
  scan: Scan,
  send: (event: ScanEvent) => void,
  signal?: AbortSignal,
): Promise<'done' | 'error' | 'cancelled'> {
  // One budget per run, not per process — otherwise the second scan of a
  // session inherits an already-spent one.
  resetSearchBudget();

  const log: Log = (level, text) => {
    scan.log.push({ at: new Date().toISOString(), level, stage: scan.stage, text });
    send({ type: 'log', line: scan.log.at(-1)! });
  };

  try {
    const servers = availableConnectors();
    log('info', `${servers.length} connectors: ${servers.join(', ') || 'none'}`);
    if (servers.length === 0) {
      log('warn', 'no usable connectors — check config/connectors.json and the credentials it names');
    }

    for (const next of stagesFor(scan)) {
      send({ type: 'stage', stage: next });
      try {
        await runStage({ scan, log, send, signal }, next);
      } catch (error) {
        // Cancelling stops the run where it is and keeps what it collected.
        // Handled before the generic branch below, which steps over a failed
        // stage and carries on — exactly what must not happen here.
        if (wasCancelled(error)) {
          scan.status = 'cancelled';
          scan.stage = next;
          log('warn', `cancelled at ${next} — keeping what was collected`);
          store.put(scan);
          send({ type: 'patch', scan: { status: 'cancelled', stage: next } });
          send({ type: 'done', scan });
          return 'cancelled';
        }
        const raw = describeError(error);
        const { message, detail, kind } = explainFailure(next, raw);
        log('error', `failed at ${next}: ${raw}`);
        scan.status = 'error';
        scan.stage = next;
        scan.failedStage = next;
        scan.error = message;
        scan.errorDetail = detail;
        scan.errorKind = kind;
        store.put(scan);
        send({ type: 'error', message, stage: next, detail, kind });
        return 'error';
      }
    }

    // A stage that fails is logged and stepped over (see runStage) so one dead
    // connector cannot throw away five good stages. That resilience used to end
    // in a lie: the loop finished, status was set to 'done' unconditionally, and
    // a scan where every single stage had failed was presented as a completed
    // scan with six empty panels. Whether the run produced anything is decided
    // here, from what is actually in the scan.
    const produced =
      scan.profiles.length + scan.mentions.length + scan.feed.length
      + scan.issues.length + scan.abuse.length;

    if (produced === 0) {
      const reason = scan.error
        ? `Every stage failed — the last error was: ${scan.error}`
        : 'Every stage ran without erroring but returned nothing at all.';
      scan.status = 'error';
      scan.stage = scan.failedStage ?? 'subject';
      scan.error = `The scan finished with no data. ${reason}`;
      scan.errorKind = scan.errorKind ?? 'other';
      log('error', 'scan produced no data at all');
      store.put(scan);
      send({ type: 'error', message: scan.error, stage: scan.stage, detail: scan.errorDetail ?? '', kind: scan.errorKind });
      return 'error';
    }

    if (scan.failedStage) {
      // Partial result: real data, but the user must be told which parts of the
      // dashboard are empty because a stage broke rather than because there was
      // nothing to find.
      log('warn', `finished with ${scan.failedStage} failed — that section is incomplete`);
    }

    scan.status = 'done';
    scan.stage = 'done';
    const spend = searchSpend();
    if (Object.keys(spend).length) {
      log('info', `paid search requests this run: ${
        Object.entries(spend).map(([k, n]) => `${k} ${n}`).join(', ')}`);
    }
    log('stage', 'done');
    store.put(scan);
    send({ type: 'done', scan });
    return 'done';
  } catch (error) {
    const message = describeError(error);
    log('error', message);
    store.patch(scan.id, { status: 'error', error: message });
    send({ type: 'error', message });
    return 'error';
  }
}
