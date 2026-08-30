import type { Scan, ScanEvent, Stage } from '../shared/types.ts';
import {
  buildBuzz, findAbuse, findFeed, findIssues, findMentions, findPresence, groupTopics,
  netSentiment, resolveSite, scoreBuzz, type Log,
} from './pipeline.ts';
import { withRunContext } from './agents/runtime.ts';
import { resolveSubject } from './agents/resolve-run.ts';
import { findReviewScores } from './reviews.ts';
import { brandToken } from '../shared/name.ts';
import * as store from './store.ts';

export interface StageCtx {
  scan: Scan;
  log: Log;
  send: (event: ScanEvent) => void;
}

export const STAGE_LABELS: Record<Stage, string> = {
  queued: 'queued',
  presence: 'finding accounts',
  discovery: 'searching for discussion',
  feed: 'streaming the latest videos and comments',
  buzz: 'scoring sentiment',
  health: 'triaging complaints',
  abuse: 'sweeping for scams',
  done: 'done',
};

/** A stage turned up a raw error. Explain it in plain language, classify it so
 *  the dashboard can offer the right remedy, and keep the detail around for the
 *  details toggle. */
export function explainFailure(
  stage: Stage,
  raw: string,
): { message: string; detail: string; kind: 'connector' | 'model' | 'rate' | 'timeout' | 'auth' | 'other' } {
  const detail = raw;
  const lower = raw.toLowerCase();

  if (lower.includes('no json in model output')) {
    return {
      kind: 'model',
      message:
        `The ${STAGE_LABELS[stage] || stage} step asked the model for structured data and got free text or ` +
        `an empty reply back, so it stopped here. Model output like this is often a one-off glitch — hit ` +
        `"Rerun scan" to try again. If it keeps failing, try a stronger model.`,
      detail,
    };
  }
  if (/429|rate.?limit/i.test(lower)) {
    return {
      kind: 'rate',
      message: `The ${STAGE_LABELS[stage] || stage} step hit a rate limit. Waiting a moment and retrying usually clears it.`,
      detail,
    };
  }
  if (/timeout|timed out|etimedout/i.test(lower)) {
    return {
      kind: 'timeout',
      message: `The ${STAGE_LABELS[stage] || stage} step timed out — whatever it was querying was too slow. Retrying often works.`,
      detail,
    };
  }
  if (/no connectors/i.test(lower) || /nothing to search/i.test(lower)) {
    return {
      kind: 'connector',
      message: `The ${STAGE_LABELS[stage] || stage} step has no search connectors registered, so there's nothing to query. ` +
        `Check the connectors below, re-register, then retry.`,
      detail,
    };
  }
  if (
    /mcp server|connector|credentials|x-tfy-mcp|401|403|unauthorized|unreachable|failed to (connect|join|reach)/i.test(lower)
  ) {
    return {
      kind: 'connector',
      message:
        `A search connector the ${STAGE_LABELS[stage] || stage} step relies on couldn't be reached — ` +
        `${raw.slice(0, 160)}. Reconnect the connectors below (or set the missing credentials and re-run setup), then retry.`,
      detail,
    };
  }
  if (/401|403|authoriz|no api/i.test(lower)) {
    return {
      kind: 'auth',
      message:
        `The ${STAGE_LABELS[stage] || stage} step couldn't get access it needed (missing or rejected credentials). ` +
        `Reconnect the connectors below, or set the missing credentials and re-run \`npm run setup\`.`,
      detail,
    };
  }
  return {
    kind: 'other',
    message: `The ${STAGE_LABELS[stage] || stage} step failed. ${raw.slice(0, 200)}`,
    detail,
  };
}

/** Run a single pipeline stage on an existing scan, timing it, persisting it,
 *  and emitting a `patch` describing what changed. Used both by a full scan
 *  stream and by the per-stage rerun flow.
 *
 *  A failed stage is a logged error, not the end of the scan. One connector
 *  rate-limiting you, or the model replying with free text for a turn, is not a
 *  reason to throw away the whole run — say what went wrong in the console,
 *  keep whatever the stage already produced, and let the pipeline carry on.
 *  Only a failure outside the stage itself (no scan, unreachable backend while
 *  getting the connector list) throws and takes the run down. */
export async function runStage(ctx: StageCtx, next: Stage): Promise<void> {
  const { scan, log, send } = ctx;
  const started = Date.now();
  send({ type: 'stage', stage: next });

  // Everything below runs inside this context, so an agent fired anywhere down
  // the call tree is attributed to this scan and stage without the stage
  // functions having to carry the ids around in their signatures.
  return withRunContext({ scanId: scan.id, stage: next }, async () => {
    try {
      switch (next) {
      case 'presence': {
        // Settle what the input actually is, before thirty searches quote it.
        const subject = await resolveSubject(scan.input || scan.subject?.input || scan.company, log);
        scan.subject = subject;
        if (subject.name) scan.company = subject.name;
        scan.site = subject.site || await resolveSite(subject.searchTerm || scan.company, log);
        send({ type: 'patch', scan: { subject, company: scan.company, site: scan.site } });
        log('info', `mapping ${scan.company}'s footprint (site + web sweep)`);
        scan.profiles = await findPresence(scan.company, scan.site, log);
        log('info', `footprint: ${scan.profiles.length} channels (${scan.profiles.filter((p) => p.official).length} official, ${scan.profiles.filter((p) => !p.official).length} unofficial)`);
        send({ type: 'patch', scan: { profiles: scan.profiles } });
        break;
      }
      case 'discovery': {
        scan.mentions = await findMentions(scan.company, scan.site, scan.profiles, log, scan.subject);
        log('info', `${scan.mentions.length} mentions, ${scan.mentions.filter((m) => m.date).length} of them dated`);
        send({ type: 'patch', scan: { mentions: scan.mentions } });
        break;
      }
      case 'feed': {
        scan.feed = await findFeed(scan.company, scan.site, scan.profiles, log, scan.subject);
        log('info', `feed: ${scan.feed.length} latest items, newest first`);
        send({ type: 'patch', scan: { feed: scan.feed } });
        break;
      }
      case 'buzz': {
        const buzz = await scoreBuzz(scan.company, scan.mentions, log);
        scan.mentions = buzz.mentions;
        scan.verdict = buzz.verdict;
        scan.buzz = buildBuzz(scan.mentions);
        scan.net = netSentiment(scan.buzz);
        log('info', `net sentiment ${scan.net.now.toFixed(2)} across ${scan.buzz.length} months`);

        // Built here rather than in its own stage: it needs the themes the buzz
        // agent has just written onto each mention, and it is a grouping over
        // data already in hand — no fetch, no model call.
        scan.topics = await groupTopics(scan.company, scan.mentions, log);
        const placeable = scan.mentions.filter((m) => m.date && (m.themes ?? []).length > 0).length;
        const themed = scan.mentions.filter((m) => (m.themes ?? []).length > 0).length;
        const bands = new Set(scan.topics.flatMap((point) => Object.keys(point.byTopic)));
        log(
          'info',
          `topics: ${bands.size} over ${scan.topics.length} months, from ${placeable} of ${themed} themed mentions`
          + (themed > placeable ? ` (${themed - placeable} undated, so unplaceable on a timeline)` : ''),
        );

        send({ type: 'patch', scan: { mentions: scan.mentions, buzz: scan.buzz, net: scan.net, verdict: scan.verdict, topics: scan.topics } });
        break;
      }
      case 'health': {
        scan.issues = await findIssues(scan.company, scan.mentions, log);
        log('info', `${scan.issues.length} issues catalogued`);
        send({ type: 'patch', scan: { issues: scan.issues } });
        break;
      }
      case 'abuse': {
        // The scorecard first, because it is the part anyone actually checks:
        // what the company scores on the sites a buyer looks up. It is also
        // cheap and reliable — one search per site, no fetching, no model — so
        // it lands even when the abuse sweep below finds nothing, which is most
        // of the time.
        scan.reviews = await findReviewScores(scan.subject?.searchTerm ?? brandToken(scan.company, scan.site), scan.site, log);
        if (scan.reviews.length) {
          const worst = [...scan.reviews].sort((a, b) => a.rating / a.scale - b.rating / b.scale)[0]!;
          log('info', `lowest score: ${worst.site} ${worst.rating}/${worst.scale}`);
        }
        send({ type: 'patch', scan: { reviews: scan.reviews } });
        // Saved before the slow half runs. The scorecard is sixteen searches and
        // lands in about twenty seconds; the abuse judging is minutes of model
        // time and frequently the thing that times out. Persisting only at the
        // end of the stage meant a cheap, finished result was thrown away
        // whenever the expensive one failed — and could not be seen at all until
        // it succeeded.
        //
        // Written as a patch, not a whole-record put. A stage handler holds its
        // `scan` object for minutes while the model works, so writing the whole
        // snapshot reverts anything another run persisted in the meantime —
        // which is exactly what happened here: a still-running abuse pass
        // finished and wrote its stale copy over a freshly-collected scorecard,
        // taking the stage marker back to `feed` with it.
        store.patch(scan.id, { reviews: scan.reviews });

        scan.abuse = await findAbuse(scan.company, scan.site, scan.mentions, log, scan.subject);
        log(scan.abuse.length ? 'warn' : 'info',
          scan.abuse.length ? `${scan.abuse.length} integrity findings` : 'nothing abusing the brand turned up');
        send({ type: 'patch', scan: { abuse: scan.abuse } });
        break;
      }
      case 'queued':
      case 'done':
        return;
      }
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const { message, kind } = explainFailure(next, raw);
      log('error', `failed at ${next}: ${raw}`);
      scan.error = message;
      scan.errorDetail = raw;
      scan.errorKind = kind;
      scan.failedStage = next;
    }

    scan.timings[next] = Date.now() - started;
    scan.pulledAt = { ...scan.pulledAt, [next]: new Date().toISOString() };
    scan.stage = next;
    store.put(scan);
  });
}
