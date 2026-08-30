import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import type { Scan, ScanEvent, Stage, Tracker } from '../shared/types.ts';
import { STAGES } from '../shared/types.ts';
import { cleanName, siteOf } from '../shared/name.ts';
import { availableServers, type Log } from './pipeline.ts';
import { checkConnectors, reconnectConnectors } from './connectors.ts';
import { runStage, explainFailure } from './stages.ts';
import * as store from './store.ts';
import { buildPayload } from './trackers.ts';
import * as settings from './settings.ts';
import { testReddit } from './reddit.ts';

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));

app.get('/api/health', async (_req, res) => {
  const servers = await availableServers();
  res.json({ servers, model: process.env.TRUEFORGE_MODEL ?? 'openai/gpt-5-5' });
});

app.get('/api/scans', (_req, res) => res.json(store.list()));

/** Health of the currently-registered search connectors, for the failure UI. */
app.get('/api/connectors', async (_req, res) => {
  try {
    res.json(await checkConnectors());
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/** Re-apply the connector manifests and re-probe. This is the corrective path
 *  for a connector that went stale or lost its credentials. */
app.post('/api/connectors/reconnect', async (_req, res) => {
  try {
    res.json(await reconnectConnectors());
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/** The API keys the user pastes in the Settings tab. Secrets are masked so they
 *  never round-trip to the browser. */
app.get('/api/settings/reddit', (_req, res) => {
  res.json(settings.redditPublic());
});

app.put('/api/settings/reddit', (req, res) => {
  const body = req.body ?? {};
  const next = {
    clientId: String(body.clientId ?? ''),
    clientSecret: String(body.clientSecret ?? ''),
    username: String(body.username ?? ''),
    password: String(body.password ?? ''),
    userAgent: String(body.userAgent ?? ''),
  };
  res.json(settings.setReddit(next));
});

/** A single authenticated Reddit round-trip; used by the Settings panel's
 *  "Test connection" button to confirm the pasted keys work. */
app.post('/api/settings/reddit/test', async (_req, res) => {
  const result = await testReddit();
  res.status(result.ok ? 200 : 400).json(result);
});

app.get('/api/scans/:id', (req, res) => {
  const scan = store.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'no such scan' });
  res.json(scan);
});

const STAGE_KEYS: Stage[] = STAGES.map((s) => s.key);

/** Set up an in-memory, streamed execution context for a scan id. */
function openStream(res: import('express').Response, onEvent: (event: ScanEvent) => void) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  return (event: ScanEvent) => { onEvent(event); res.write(`data: ${JSON.stringify(event)}\n\n`); };
}

/**
 * Runs a full scan, streaming progress as it goes.
 *
 * A full scan is five agent turns and takes minutes, so the client watches an
 * event stream rather than holding a request open with nothing to show.
 */
app.get('/api/scans/:id/stream', async (req, res) => {
  const raw = String(req.query.company ?? '').trim();
  if (!raw) return res.status(400).end();

  const scan: Scan = {
    id: req.params.id,
    company: cleanName(raw),
    site: siteOf(raw),
    createdAt: new Date().toISOString(),
    status: 'running',
    stage: 'queued',
    profiles: [],
    mentions: [],
    issues: [],
    abuse: [],
    buzz: [],
    topics: [],
    migrations: [],
    feed: [],
    log: [],
    timings: {},
    verdict: '',
    net: { now: 0, delta: 0 },
  };
  store.put(scan);

  const send = openStream(res, () => {});
  const log: Log = (level, text) => {
    scan.log.push({ at: new Date().toISOString(), level, stage: scan.stage, text });
    send({ type: 'log', line: scan.log.at(-1)! });
  };

  try {
    const servers = await availableServers();
    log('info', `${servers.length} connectors: ${servers.join(', ') || 'none'}`);
    if (servers.length === 0) log('warn', 'nothing to search with — run `npm run setup`');

    for (const next of STAGE_KEYS) {
      send({ type: 'stage', stage: next });
      try {
        await runStage({ scan, servers, log, send }, next);
      } catch (error) {
        const raw = error instanceof Error ? error.message : String(error);
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
        res.end();
        return;
      }
    }

    // A stage that fails is logged and stepped over (see runStage) so one dead
    // connector cannot throw away five good stages. That resilience used to end
    // in a lie: the loop finished, status was set to 'done' unconditionally, and
    // a scan where every single stage had failed was presented as a completed
    // scan with six empty panels. Whether the run produced anything is decided
    // here, from what is actually in the scan.
    const produced =
      scan.profiles.length + scan.mentions.length + scan.feed.length +
      scan.issues.length + scan.abuse.length;

    if (produced === 0) {
      const reason = scan.error
        ? `Every stage failed — the last error was: ${scan.error}`
        : 'Every stage ran without erroring but returned nothing at all.';
      scan.status = 'error';
      scan.stage = scan.failedStage ?? 'presence';
      scan.error = `The scan finished with no data. ${reason}`;
      scan.errorKind = scan.errorKind ?? 'other';
      log('error', 'scan produced no data at all');
      store.put(scan);
      send({ type: 'error', message: scan.error, stage: scan.stage, detail: scan.errorDetail ?? '', kind: scan.errorKind });
      return;
    }

    if (scan.failedStage) {
      // Partial result: real data, but the user must be told which parts of the
      // dashboard are empty because a stage broke rather than because there was
      // nothing to find.
      log('warn', `finished with ${scan.failedStage} failed — that section is incomplete`);
    }

    scan.status = 'done';
    scan.stage = 'done';
    log('stage', 'done');
    store.put(scan);
    send({ type: 'done', scan });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log('error', message);
    store.put({ ...scan, status: 'error', error: message });
    send({ type: 'error', message });
  } finally {
    res.end();
  }
});

/** Re-run a single stage on an existing scan, streamed. Each stage runs against
 *  whatever the scan already holds, and patches just its own slice of data.
 *
 *  `?reset=1` (sent by the rerun-all flow) starts the console over: the previous
 *  run's log lines and any stale error state are dropped first, so the stream
 *  reflects exactly the run the user just asked for. */
app.get('/api/scans/:id/stages/:stage/stream', async (req, res) => {
  const scan = store.get(req.params.id);
  const next = req.params.stage as Stage;
  if (!scan) return res.status(404).json({ error: 'no such scan' });
  if (!(STAGE_KEYS as string[]).includes(next)) return res.status(400).json({ error: 'no such stage' });

  if (req.query.reset === '1') {
    scan.log = [];
    scan.error = undefined;
    scan.errorDetail = undefined;
    scan.failedStage = undefined;
    scan.errorKind = undefined;
    store.put(scan);
  }

  const send = openStream(res, () => {});
  const log: Log = (level, text) => {
    scan.log.push({ at: new Date().toISOString(), level, stage: next, text });
    send({ type: 'log', line: scan.log.at(-1)! });
  };

  try {
    const servers = await availableServers();
    scan.status = 'running';
    scan.stage = next;
    store.put(scan);
    await runStage({ scan, servers, log, send }, next);
    scan.status = 'done';
    scan.stage = 'done';
    store.put(scan);
    send({ type: 'patch', scan: { status: 'done', stage: 'done' } });
    send({ type: 'done', scan });
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const { message, detail, kind } = explainFailure(next, raw);
    log('error', `failed at ${next}: ${raw}`);
    store.put({
      ...scan,
      status: 'error',
      stage: next,
      failedStage: next,
      error: message,
      errorDetail: detail,
      errorKind: kind,
    });
    send({ type: 'error', message, stage: next, detail, kind });
  } finally {
    res.end();
  }
});

app.post('/api/scans', (_req, res) => res.json({ id: randomUUID().slice(0, 8) }));

/** Preview what would be filed. Nothing leaves this machine on a preview. */
app.post('/api/scans/:id/issues/:issueId/payload', (req, res) => {
  const scan = store.get(req.params.id);
  const issue = scan?.issues.find((i) => i.id === req.params.issueId);
  if (!scan || !issue) return res.status(404).json({ error: 'no such issue' });
  res.json(buildPayload(scan, issue, (req.body?.tracker ?? 'clipboard') as Tracker));
});

/** Record that an issue was filed. The send itself runs through the tracker's
 *  MCP server once one is connected; until then this marks it and keeps the
 *  payload, so the catalogue reflects what a human actually did. */
app.post('/api/scans/:id/issues/:issueId/file', (req, res) => {
  const scan = store.get(req.params.id);
  const issue = scan?.issues.find((i) => i.id === req.params.issueId);
  if (!scan || !issue) return res.status(404).json({ error: 'no such issue' });

  const tracker = (req.body?.tracker ?? 'clipboard') as Tracker;
  issue.status = 'filed';
  issue.filedTo = { tracker, ref: req.body?.ref ?? 'pending', at: new Date().toISOString() };
  store.put(scan);
  res.json(issue);
});

app.post('/api/scans/:id/abuse/:findingId/status', (req, res) => {
  const scan = store.get(req.params.id);
  const finding = scan?.abuse.find((f) => f.id === req.params.findingId);
  if (!scan || !finding) return res.status(404).json({ error: 'no such finding' });
  finding.status = req.body.status;
  store.put(scan);
  res.json(finding);
});

app.post('/api/scans/:id/issues/:issueId/status', (req, res) => {
  const scan = store.get(req.params.id);
  const issue = scan?.issues.find((i) => i.id === req.params.issueId);
  if (!scan || !issue) return res.status(404).json({ error: 'no such issue' });
  issue.status = req.body.status;
  store.put(scan);
  res.json(issue);
});

const port = Number(process.env.PORT ?? 8791);
app.listen(port, '127.0.0.1', () => console.log(`whisperer API on http://127.0.0.1:${port}`));
