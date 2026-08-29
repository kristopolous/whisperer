import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import type { Scan, ScanEvent, Stage, Tracker } from '../shared/types.ts';
import { STAGES } from '../shared/types.ts';
import { availableServers, type Log } from './pipeline.ts';
import { runStage, explainFailure } from './stages.ts';
import * as store from './store.ts';
import { buildPayload } from './trackers.ts';

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));

app.get('/api/health', async (_req, res) => {
  const servers = await availableServers();
  res.json({ servers, model: process.env.TRUEFORGE_MODEL ?? 'openai/gpt-5-5' });
});

app.get('/api/scans', (_req, res) => res.json(store.list()));

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
  const company = String(req.query.company ?? '').trim();
  if (!company) return res.status(400).end();

  const scan: Scan = {
    id: req.params.id,
    company,
    site: '',
    createdAt: new Date().toISOString(),
    status: 'running',
    stage: 'queued',
    profiles: [],
    mentions: [],
    issues: [],
    abuse: [],
    buzz: [],
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
        const { message, detail } = explainFailure(next, raw);
        log('error', `failed at ${next}: ${raw}`);
        scan.status = 'error';
        scan.stage = next;
        scan.failedStage = next;
        scan.error = message;
        scan.errorDetail = detail;
        store.put(scan);
        send({ type: 'error', message, stage: next, detail });
        res.end();
        return;
      }
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
 *  whatever the scan already holds, and patches just its own slice of data. */
app.get('/api/scans/:id/stages/:stage/stream', async (req, res) => {
  const scan = store.get(req.params.id);
  const next = req.params.stage as Stage;
  if (!scan) return res.status(404).json({ error: 'no such scan' });
  if (!(STAGE_KEYS as string[]).includes(next)) return res.status(400).json({ error: 'no such stage' });

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
    const { message, detail } = explainFailure(next, raw);
    log('error', `failed at ${next}: ${raw}`);
    store.put({
      ...scan,
      status: 'error',
      stage: next,
      failedStage: next,
      error: message,
      errorDetail: detail,
    });
    send({ type: 'error', message, stage: next, detail });
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
