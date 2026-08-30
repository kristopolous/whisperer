import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import type { Scan, ScanEvent, Stage, Tracker } from '../shared/types.ts';
import { STAGES } from '../shared/types.ts';
import { cleanName, siteOf } from '../shared/name.ts';
import type { Log } from './pipeline.ts';
import { AGENTS } from './agents/registry.ts';
import { onAgentRun, recentRuns, runsForScan, statsFor } from './agents/runtime.ts';
import { cacheSize, cacheStats, clearCache } from './cache.ts';
import { askJsonDirect } from './model.ts';
import { recordLoopStep } from './channels/github.ts';
import { channelStates, reloadChannels } from './channels/index.ts';
import { enabledConnectors, inferenceConfig, inferenceHost, inferenceHosts, patchConnector, patchInferenceHost, reloadConfig } from './config.ts';
import { discard, outbox } from './outbox.ts';
import { secretSource, setSecrets } from './secrets.ts';
import { availableConnectors, checkConnectors } from './mcp.ts';
import { runStage, explainFailure } from './stages.ts';
import * as store from './store.ts';
import { buildPayload } from './trackers.ts';
import { fileTicket, submitTicket, ticketFiledEvent } from './agents/file-ticket.ts';
import { respondToUser, deliverReply, replyEvent, type ReplyPhase } from './agents/respond-to-user.ts';
import * as settings from './settings.ts';
import { testReddit } from './reddit.ts';

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));

app.get('/api/health', (_req, res) => {
  const host = inferenceHost();
  res.json({
    servers: availableConnectors(),
    model: `${host.key}/${host.modelId}`,
    inference: { host: host.key, baseUrl: host.baseUrl, isExample: inferenceConfig().isExample },
  });
});

app.get('/api/scans', (_req, res) => res.json(store.list()));

/** The agent list: every agent this app has, what it is for, and how its runs
 *  have actually gone.
 *
 *  This is the thing a hosted agent platform would not tell us. An agent that
 *  has never run, one that ran and failed, and one that runs fine but takes
 *  ninety seconds are three completely different situations, and they are
 *  indistinguishable from an empty dashboard panel. */
app.get('/api/agents', (_req, res) => {
  res.json(AGENTS.map((agent) => ({
    name: agent.name,
    title: agent.title,
    description: agent.description,
    surface: agent.surface,
    stage: agent.stage,
    connectors: agent.connectors,
    effort: agent.effort,
    inPipeline: agent.inPipeline,
    /** Roughly how big the standing instructions are — the prompt is the asset,
     *  and its size is worth seeing next to a context-length limit. */
    instructionChars: agent.instructions.length,
    stats: statsFor(agent.name),
  })));
});

/** The run log, newest first. */
app.get('/api/agents/runs', (req, res) => {
  const scanId = req.query.scan ? String(req.query.scan) : null;
  res.json(scanId ? runsForScan(scanId) : recentRuns(Number(req.query.limit ?? 100)));
});

/** Live run events, so the agent list moves while a scan is going. */
app.get('/api/agents/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  for (const run of recentRuns(25).reverse()) res.write(`data: ${JSON.stringify(run)}\n\n`);
  const off = onAgentRun((run) => res.write(`data: ${JSON.stringify(run)}\n\n`));
  req.on('close', off);
});

/** What the disk cache is holding, and whether it is being hit. A stage that
 *  finishes suspiciously fast should be explainable rather than surprising. */
app.get('/api/cache', (_req, res) => {
  res.json({ stats: cacheStats(), namespaces: cacheSize() });
});

app.delete('/api/cache', (req, res) => {
  clearCache(req.query.namespace ? String(req.query.namespace) : undefined);
  res.json({ cleared: true, namespaces: cacheSize() });
});

/** Outbound write channels and what each is actually blocked on. Separate
 *  endpoint from /api/connectors because reads and writes are separate
 *  concerns: one is what we may look at, the other is what we may say. */
app.get('/api/channels', (_req, res) => {
  try {
    reloadChannels();
    res.json(channelStates());
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/** Health of the currently-registered search connectors, for the failure UI. */
app.get('/api/connectors', async (_req, res) => {
  try {
    res.json(await checkConnectors());
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/** Which credentials the configured connectors and channels want, whether each
 *  is set, and where it came from. Never the values themselves. */
app.get('/api/credentials', (_req, res) => {
  try {
    const fromConnectors = enabledConnectors().flatMap((c) =>
      (c.requires ?? []).map((name) => ({ name, usedBy: c.name, kind: 'connector' as const })));
    const fromChannels = channelStates().flatMap((c) =>
      (c.requires ?? []).map((name) => ({ name, usedBy: c.label, kind: 'channel' as const })));

    // One row per credential, listing everything that wants it — several
    // connectors can share a key and asking for it twice would be silly.
    const byName = new Map<string, { name: string; usedBy: string[]; kind: string; source: string }>();
    for (const entry of [...fromConnectors, ...fromChannels]) {
      const row = byName.get(entry.name) ?? {
        name: entry.name, usedBy: [], kind: entry.kind, source: secretSource(entry.name),
      };
      row.usedBy.push(entry.usedBy);
      byName.set(entry.name, row);
    }
    res.json([...byName.values()].sort((a, b) => a.name.localeCompare(b.name)));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/** Save credentials typed into the settings screen. Write-only: the values are
 *  never read back out, and an empty string clears one. */
app.put('/api/credentials', async (req, res) => {
  try {
    const values = req.body as Record<string, string>;
    if (!values || typeof values !== 'object') return res.status(400).json({ error: 'expected an object' });
    setSecrets(values);
    // Re-probe immediately: the point of typing a key is to find out whether it
    // works, and making someone press a second button to learn that is the same
    // failure as sending them to .env.
    res.json(await checkConnectors());
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/** What the system would have said to real people, and did not.
 *
 *  Kept as its own surface rather than buried in each issue: the useful review
 *  question is "read everything we were about to post", not "click through
 *  twelve issues". */
app.get('/api/outbox', (req, res) => {
  res.json(outbox(req.query.scan ? String(req.query.scan) : undefined));
});

app.post('/api/outbox/:id/discard', (req, res) => {
  res.json({ discarded: discard(req.params.id) });
});

/** The configured inference hosts, without their keys. */
app.get('/api/inference', (_req, res) => {
  try {
    res.json(inferenceHosts());
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/** Change where inference runs — endpoint, model id, and optionally a key.
 *
 *  `apiKey` is write-only and optional: omit it to leave whatever is stored
 *  alone, send an empty string to remove it. A local endpoint usually needs
 *  none at all, so "no key" is a normal state rather than a misconfiguration. */
app.put('/api/inference', (req, res) => {
  try {
    const hostKey = String(req.body?.host ?? '').trim();
    if (!hostKey) return res.status(400).json({ error: 'host is required' });

    const changes: Parameters<typeof patchInferenceHost>[1] = {};
    if (typeof req.body.baseUrl === 'string') changes.baseUrl = req.body.baseUrl.trim();
    if (typeof req.body.modelId === 'string') changes.modelId = req.body.modelId;
    if (typeof req.body.apiKey === 'string') changes.apiKey = req.body.apiKey;
    if (Number.isFinite(req.body.contextLength)) changes.contextLength = Number(req.body.contextLength);
    if (Number.isFinite(req.body.maxOutputTokens)) changes.maxOutputTokens = Number(req.body.maxOutputTokens);
    if (req.body.makeDefault === true) changes.makeDefault = true;

    patchInferenceHost(hostKey, changes);
    res.json(inferenceHosts());
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/** Ask the configured endpoint for one tiny schema-constrained answer.
 *
 *  Worth having as its own button: the endpoint being reachable, the model
 *  existing, and the endpoint honouring `response_format` are three separate
 *  things, and only the third one is what this app actually depends on. A proxy
 *  that accepts the schema and quietly forwards the request without it looks
 *  identical to success until a stage returns prose. */
app.post('/api/inference/test', async (_req, res) => {
  const started = Date.now();
  try {
    const answer = await askJsonDirect<{ ok: string }>({
      instructions: 'You reply only with JSON matching the schema.',
      prompt: 'Set ok to the string "ok".',
      schema: {
        name: 'probe',
        schema: {
          type: 'object', required: ['ok'], additionalProperties: false,
          properties: { ok: { type: 'string' } },
        },
      },
      timeoutMs: 120_000,
    });
    res.json({
      ok: true,
      ms: Date.now() - started,
      schemaHonoured: typeof answer?.ok === 'string',
    });
  } catch (error) {
    res.json({
      ok: false,
      ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

/** Edit one connector from the settings dashboard — where it lives, and
 *  whether it is in play. Credentials are not editable here on purpose: they
 *  belong in .env, and the connector's `requires` list is what reports a
 *  missing one. */
app.put('/api/connectors/:name', async (req, res) => {
  try {
    const changes: { url?: string; enabled?: boolean } = {};
    if (typeof req.body?.url === 'string') changes.url = req.body.url.trim();
    if (typeof req.body?.enabled === 'boolean') changes.enabled = req.body.enabled;
    patchConnector(req.params.name, changes);
    // Re-probe everything rather than just this row: enabling one connector
    // changes what the list means, and a stale neighbour is confusing.
    res.json(await checkConnectors());
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/** Re-read config/connectors.json and re-probe. Connectors are dialled
 *  directly now, so there are no manifests to re-apply — the corrective path
 *  for one that went stale is to pick up any config edit and dial it again. */
app.post('/api/connectors/reconnect', async (_req, res) => {
  try {
    reloadConfig();
    res.json(await checkConnectors());
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
    const servers = availableConnectors();
    log('info', `${servers.length} connectors: ${servers.join(', ') || 'none'}`);
    if (servers.length === 0) log('warn', 'no usable connectors — check config/connectors.json and the credentials it names');

    for (const next of STAGE_KEYS) {
      send({ type: 'stage', stage: next });
      try {
        await runStage({ scan, log, send }, next);
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
    const servers = availableConnectors();
    scan.status = 'running';
    scan.stage = next;
    store.put(scan);
    await runStage({ scan, log, send }, next);
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

/** Remove a scan, and every other attempt at the same company, since that is
 *  what one row in the sidebar stands for. Deliberately explicit about how many
 *  records went: "removed 1" and "removed 4" are different events and the
 *  caller should be able to tell the user which happened. */
app.delete('/api/scans/:id', (req, res) => {
  const removed = store.remove(req.params.id);
  if (removed.length === 0) return res.status(404).json({ error: 'no such scan' });
  res.json({ removed, runs: store.list() });
});

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

/* Serve the built dashboard from the API process when a build exists.
 *
 * In development the Vite dev server owns the UI and proxies /api here, so
 * this does nothing. In a deployment there is no Vite, and running a second
 * process just to hand over static files is a worse thing to operate than one
 * process that serves both. Registered last so it can never shadow /api. */
/* ------------------------------------------------------- loop agents ---- */

/** Draft a real engineering ticket for an issue.
 *
 *  Distinct from /payload, which renders the existing issue into a tracker's
 *  envelope from a template. This reads what the reporters actually wrote and
 *  reconstructs repro steps, expected/actual and acceptance criteria — the part
 *  that otherwise costs a person twenty minutes per ticket. */
app.post('/api/scans/:id/issues/:issueId/ticket', async (req, res) => {
  const scan = store.get(req.params.id);
  const issue = scan?.issues.find((i) => i.id === req.params.issueId);
  if (!scan || !issue) return res.status(404).json({ error: 'no such issue' });

  try {
    const tracker = (req.body?.tracker ?? 'clipboard') as Tracker;
    const draft = await fileTicket(scan, issue, tracker);

    // `submit=true` is the caller saying "actually file it". It still will not,
    // until a tracker credential is configured — but the distinction between
    // drafting and filing lives here rather than being blurred.
    if (req.body?.submit) {
      const result = await submitTicket(draft, scan, issue);
      if (result.filed) {
        issue.status = 'filed';
        issue.filedTo = { tracker, ref: result.ref ?? 'filed', at: new Date().toISOString() };
        issue.loop = [...(issue.loop ?? []), ticketFiledEvent(tracker, result.ref ?? 'filed', result.url)];
        store.put(scan);
      }
      return res.json({ draft, ...result });
    }

    res.json({ draft, filed: false });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'ticket drafting failed' });
  }
});

/** Draft the reply that goes back to the person who reported it.
 *
 *  `phase` picks the message: `acknowledge` before anything is fixed,
 *  `fix-notify` after, which asks them to confirm rather than telling them it
 *  works. Only their confirmation may close the issue, so the follow-up is a
 *  question and the endpoint cannot itself mark anything resolved. */
app.post('/api/scans/:id/issues/:issueId/reply', async (req, res) => {
  const scan = store.get(req.params.id);
  const issue = scan?.issues.find((i) => i.id === req.params.issueId);
  if (!scan || !issue) return res.status(404).json({ error: 'no such issue' });

  const phase = (req.body?.phase ?? 'acknowledge') as ReplyPhase;
  if (phase !== 'acknowledge' && phase !== 'fix-notify') {
    return res.status(400).json({ error: 'phase must be "acknowledge" or "fix-notify"' });
  }

  try {
    const draft = await respondToUser(scan, issue, phase, {
      ticketRef: issue.filedTo?.ref,
      whatChanged: req.body?.whatChanged,
    });

    if (req.body?.send) {
      const result = await deliverReply(draft, { scan, issue, phase });
      if (result.sent) {
        const event = replyEvent(draft, issue.reporter);
        issue.loop = [...(issue.loop ?? []), event];
        if (phase === 'acknowledge') issue.status = 'responded';
        store.put(scan);
        // The ledger gets the verbatim message. Annotating it must never fail
        // the send that already happened, so this swallows its own errors.
        await recordLoopStep(issue, event);
      }
      return res.json({ draft, ...result });
    }

    res.json({ draft, sent: false });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'reply drafting failed' });
  }
});

/** The reporter came back and said it works.
 *
 *  Deliberately the only route that can close an issue, and it takes their
 *  words rather than a boolean — the audit trail is worth nothing if "the
 *  reporter confirmed" can be recorded without what they said. */
app.post('/api/scans/:id/issues/:issueId/confirm', async (req, res) => {
  const scan = store.get(req.params.id);
  const issue = scan?.issues.find((i) => i.id === req.params.issueId);
  if (!scan || !issue) return res.status(404).json({ error: 'no such issue' });

  const said = String(req.body?.message ?? '').trim();
  if (!said) return res.status(400).json({ error: 'the reporter\'s own words are required to close an issue' });

  const at = new Date().toISOString();
  issue.loop = [
    ...(issue.loop ?? []),
    {
      id: randomUUID().slice(0, 8),
      step: 'confirmed',
      actor: 'reporter',
      at,
      human: true,
      summary: 'Reporter confirmed the fix works.',
      message: said,
      ref: issue.reporter ? { label: 'confirmation in thread', url: issue.reporter.sourceUrl } : undefined,
    },
    {
      id: randomUUID().slice(0, 8),
      step: 'closed',
      actor: 'system',
      at,
      human: false,
      summary: 'Closed on the reporter\'s confirmation.',
    },
  ];
  issue.status = 'closed';
  store.put(scan);

  // Both closing steps go onto the ledger, so the filed issue ends with the
  // reporter's own words rather than with someone's assertion that it is done.
  for (const event of issue.loop.slice(-2)) await recordLoopStep(issue, event);

  res.json(issue);
});

const DIST = path.resolve(import.meta.dirname, '../web/dist');
if (existsSync(DIST)) {
  app.use(express.static(DIST));
  // The dashboard routes on the hash, but a deep link or a refresh still has
  // to land on index.html rather than a 404.
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(DIST, 'index.html')));
  console.log(`serving dashboard from ${DIST}`);
}

const port = Number(process.env.PORT ?? 8791);

/* Bind to loopback unless told otherwise.
 *
 * A scan report names real people and quotes them, so the default should never
 * be "reachable from the internet because it happened to start on a server".
 * Deployments that want a wider bind set HOST explicitly and put their own
 * access control in front of it. */
const host = process.env.HOST ?? '127.0.0.1';
app.listen(port, host, () => console.log(`whisperer on http://${host}:${port}`));
