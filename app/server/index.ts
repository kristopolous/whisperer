import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import type { Scan, ScanEvent, Tracker } from '../shared/types.ts';
import {
  availableServers, buildBuzz, findIssues, findMentions, findPresence,
  netSentiment, resolveSite, scoreBuzz,
} from './pipeline.ts';
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

/**
 * Runs a scan and streams progress as it goes.
 *
 * A full scan is four agent turns and takes minutes, so the client watches an
 * event stream rather than holding a request open with nothing to show.
 */
app.get('/api/scans/:id/stream', async (req, res) => {
  const company = String(req.query.company ?? '').trim();
  if (!company) return res.status(400).end();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const emit = (event: ScanEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);

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
    buzz: [],
    verdict: '',
    net: { now: 0, delta: 0 },
  };
  store.put(scan);

  try {
    const servers = await availableServers();

    emit({ type: 'stage', stage: 'presence' });
    scan.site = await resolveSite(company, servers, emit);
    emit({ type: 'patch', scan: { site: scan.site } });
    scan.profiles = await findPresence(scan.site);
    store.put({ ...scan, stage: 'presence' });
    emit({ type: 'patch', scan: { profiles: scan.profiles } });

    emit({ type: 'stage', stage: 'discovery' });
    scan.mentions = await findMentions(company, scan.site, servers, emit);
    store.put({ ...scan, stage: 'discovery' });
    emit({ type: 'patch', scan: { mentions: scan.mentions } });

    emit({ type: 'stage', stage: 'buzz' });
    const buzz = await scoreBuzz(company, scan.mentions, emit);
    scan.mentions = buzz.mentions;
    scan.verdict = buzz.verdict;
    scan.buzz = buildBuzz(scan.mentions);
    scan.net = netSentiment(scan.buzz);
    store.put({ ...scan, stage: 'buzz' });
    emit({ type: 'patch', scan: { mentions: scan.mentions, buzz: scan.buzz, net: scan.net, verdict: scan.verdict } });

    emit({ type: 'stage', stage: 'health' });
    scan.issues = await findIssues(company, scan.mentions, emit);

    scan.status = 'done';
    scan.stage = 'done';
    store.put(scan);
    emit({ type: 'done', scan });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.put({ ...scan, status: 'error', error: message });
    emit({ type: 'error', message });
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
