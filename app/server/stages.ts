import type { Scan, ScanEvent, Stage } from '../shared/types.ts';
import {
  buildBuzz, findAbuse, findIssues, findMentions, findPresence,
  netSentiment, resolveSite, scoreBuzz, type Log,
} from './pipeline.ts';
import * as store from './store.ts';

export interface StageCtx {
  scan: Scan;
  servers: string[];
  log: Log;
  send: (event: ScanEvent) => void;
}

export const STAGE_LABELS: Record<Stage, string> = {
  queued: 'queued',
  presence: 'finding accounts',
  discovery: 'searching for discussion',
  buzz: 'scoring sentiment',
  health: 'triaging complaints',
  abuse: 'sweeping for scams',
  done: 'done',
};

/** A stage turned up a raw error. Explain it in plain language and keep the
 *  detail around so the dashboard can offer a details toggle. */
export function explainFailure(stage: Stage, raw: string): { message: string; detail: string } {
  const detail = raw;
  const lower = raw.toLowerCase();

  if (lower.includes('no json in model output')) {
    return {
      message:
        `The ${STAGE_LABELS[stage] || stage} step asked the model for structured data and got free text or an ` +
        `empty reply back, so it couldn't continue. This usually means the configured model isn't returning ` +
        `statement JSON — try a stronger model, or retry the stage once to rule out a one-off glitch.`,
      detail,
    };
  }
  if (/429|rate.?limit/i.test(lower)) {
    return {
      message: `The ${STAGE_LABELS[stage] || stage} step hit a rate limit. Waiting a moment and retrying usually clears it.`,
      detail,
    };
  }
  if (/timeout|timed out|etimedout/i.test(lower)) {
    return {
      message: `The ${STAGE_LABELS[stage] || stage} step timed out — whatever it was querying was too slow. Retrying often works.`,
      detail,
    };
  }
  if (/auth|authoriz|401|403|no api/i.test(lower)) {
    return {
      message: `The ${STAGE_LABELS[stage] || stage} step couldn't get access it needed (missing or rejected credentials). ` +
        `Run \`npm run setup\` and reconnect the connectors, then retry.`,
      detail,
    };
  }
  if (/no connectors/i.test(lower) || /nothing to search/i.test(lower)) {
    return {
      message: `The ${STAGE_LABELS[stage] || stage} step has no search connectors registered, so there's nothing to query. ` +
        `Run \`npm run setup\` to register MCP servers, then retry.`,
      detail,
    };
  }
  return {
    message: `The ${STAGE_LABELS[stage] || stage} step failed. ${raw.slice(0, 200)}`,
    detail,
  };
}

/** Run a single pipeline stage on an existing scan, timing it, persisting it,
 *  and emitting a `patch` describing what changed. Used both by a full scan
 *  stream and by the per-stage rerun flow. */
export async function runStage(ctx: StageCtx, next: Stage): Promise<void> {
  const { scan, servers, log, send } = ctx;
  const started = Date.now();
  send({ type: 'stage', stage: next });
  log('stage', STAGE_LABELS[next]);

  switch (next) {
    case 'presence': {
      scan.site = await resolveSite(scan.company, servers, log);
      send({ type: 'patch', scan: { site: scan.site } });
      log('info', `reading ${scan.site} with a headless browser`);
      scan.profiles = await findPresence(scan.site);
      log('info', `found ${scan.profiles.length} accounts: ${scan.profiles.map((p) => p.platform).join(', ') || 'none'}`);
      send({ type: 'patch', scan: { profiles: scan.profiles } });
      break;
    }
    case 'discovery': {
      scan.mentions = await findMentions(scan.company, scan.site, scan.profiles, servers, log);
      log('info', `${scan.mentions.length} mentions, ${scan.mentions.filter((m) => m.date).length} of them dated`);
      send({ type: 'patch', scan: { mentions: scan.mentions } });
      break;
    }
    case 'buzz': {
      const buzz = await scoreBuzz(scan.company, scan.mentions, log);
      scan.mentions = buzz.mentions;
      scan.verdict = buzz.verdict;
      scan.buzz = buildBuzz(scan.mentions);
      scan.net = netSentiment(scan.buzz);
      log('info', `net sentiment ${scan.net.now.toFixed(2)} across ${scan.buzz.length} months`);
      send({ type: 'patch', scan: { mentions: scan.mentions, buzz: scan.buzz, net: scan.net, verdict: scan.verdict } });
      break;
    }
    case 'health': {
      scan.issues = await findIssues(scan.company, scan.mentions, log);
      log('info', `${scan.issues.length} issues catalogued`);
      send({ type: 'patch', scan: { issues: scan.issues } });
      break;
    }
    case 'abuse': {
      try {
        scan.abuse = await findAbuse(scan.company, scan.site, scan.mentions, servers, log);
        log(scan.abuse.length ? 'warn' : 'info',
          scan.abuse.length ? `${scan.abuse.length} integrity findings` : 'nothing abusing the brand turned up');
      } catch (error) {
        log('error', `integrity sweep failed: ${error instanceof Error ? error.message : error}`);
      }
      send({ type: 'patch', scan: { abuse: scan.abuse } });
      break;
    }
    case 'queued':
    case 'done':
      return;
  }

  scan.timings[next] = Date.now() - started;
  scan.stage = next;
  store.put(scan);
}
