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
import { addConnector, enabledConnectors, missingCredentials, removeConnector, inferenceConfig, inferenceHost, inferenceHosts, patchConnector, patchInferenceHost, reloadConfig } from './config.ts';
import { diagnoseIssue } from './agents/diagnose-run.ts';
import { fixIssue } from './agents/fix-run.ts';
import { ensureFork } from './channels/fork.ts';
import { openPullRequest } from './channels/github.ts';
import { discard, outbox } from './outbox.ts';
import { ensureCheckout, patchProject, projectFor, reloadRepos, repoConfig } from './repos.ts';
import { hintFor, warnAbout } from './credential-hints.ts';
import { secretSource, setSecrets, storedSecrets } from './secrets.ts';
import { availableConnectors, checkConnectors, listTools, toolUsage, type McpTool } from './mcp.ts';
import {
  guessArg, guessTool, ROLES, ROLE_INFO, type ConnectorRole, type RoleBinding,
} from './roles.ts';
import { runStage, explainFailure } from './stages.ts';
import * as store from './store.ts';
import { buildSeries } from './series.ts';
import { describeError } from './errors.ts';
import { performScan } from './run.ts';
import { listSchedule, removeEntry, runningNow, startScheduler, upsert } from './schedule.ts';
import { listCredits, setLedger } from './credits.ts';
import { add as addProfile, applyOverrides, block, overridesFor, unblock } from './presence-overrides.ts';
import { LANGUAGES } from './languages.ts';
import { buildPayload } from './trackers.ts';
import { fileTicket, submitTicket, ticketFiledEvent } from './agents/file-ticket.ts';
import { respondToUser, deliverReply, replyEvent, type ReplyPhase } from './agents/respond-to-user.ts';
import { testReddit } from './reddit.ts';
import { sourceStates } from './sources/index.ts';
import { investigate } from './agents/investigate-run.ts';
import { withRunContext } from './run-context.ts';
import { chainFor, listProviders, setRoleChain } from './providers.ts';
import { listWorkspaces, resolveWorkspace, workspaceRoot, WorkspaceError } from './workspace.ts';
import { braveExhausted, resetSearchBudget, searchSpend } from './search.ts';
import * as cancel from './cancel.ts';
import { wasCancelled } from './run-context.ts';

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));

app.get('/api/health', (_req, res) => {
  const host = inferenceHost();
  res.json({
    servers: availableConnectors(),
    model: `${host.key}/${host.modelId}`,
    inference: { host: host.key, baseUrl: host.baseUrl, isExample: inferenceConfig().isExample },
    // Whether the primary search provider has spent its allowance. Surfaced
    // rather than left to be inferred from slow scans and thin results: a
    // spent quota looks exactly like "the internet is quiet about this
    // product", which is the one conclusion this tool must never reach by
    // accident.
    search: { braveQuotaSpent: braveExhausted() },
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
    needsTools: agent.needsTools ?? false,
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
/** The sources a scan reads by asking the venue directly, and whether each one
 *  has what it needs. Not connectors — see app/server/sources/index.ts. */
app.get('/api/sources', (_req, res) => res.json(sourceStates()));

/** The git checkouts sitting in the workspace, for the "which code?" picker.
 *
 *  A list rather than a text box, deliberately. Offering what is actually there
 *  is friendlier, and a name chosen from a list cannot be a probe for somewhere
 *  else on the filesystem — the resolver refuses those anyway, but the best
 *  input is one that never has to be refused. */
app.get('/api/workspaces', async (_req, res) => {
  try {
    res.json({ root: workspaceRoot(), workspaces: await listWorkspaces() });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/** Point a scan at a checkout in the workspace, or clear it.
 *
 *  Validated here, on the way in, rather than at the point of use: storing a
 *  name that will be refused later means the dashboard shows the scan as
 *  configured and it fails minutes afterwards, in a stage that looks unrelated. */
app.post('/api/scans/:id/workspace', (req, res) => {
  const scan = store.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'no such scan' });

  const name = String(req.body?.workspace ?? '').trim();
  if (!name) {
    scan.workspace = undefined;
    store.put(scan);
    return res.json({ workspace: null });
  }

  try {
    resolveWorkspace(name);
  } catch (error) {
    return res.status(400).json({
      error: error instanceof WorkspaceError ? error.message : 'that workspace cannot be used',
    });
  }

  scan.workspace = name;
  store.put(scan);
  // The resolved path is deliberately NOT returned. The dashboard has no use
  // for it, and echoing filesystem layout back to a browser is how a probe
  // learns whether a guess landed.
  res.json({ workspace: name });
});

/** One authenticated round-trip against a source that needs credentials, so
 *  "are these keys any good" is answerable without running a scan.
 *
 *  Worth a button rather than an inference from the readiness dot: readiness
 *  only says a value is present. Reddit's credentials were present and were
 *  six-character garbage for this project's entire life, and every scan since
 *  quietly ran without Reddit while the settings screen showed it configured. */
app.post('/api/sources/:id/test', async (req, res) => {
  if (req.params.id !== 'reddit') {
    return res.status(400).json({ ok: false, error: 'that source has nothing to authenticate' });
  }
  const result = await testReddit();
  res.status(result.ok ? 200 : 400).json(result);
});

app.get('/api/credentials', (_req, res) => {
  try {
    const fromConnectors = enabledConnectors().flatMap((c) =>
      (c.requires ?? []).map((name) => ({ name, usedBy: c.name, kind: 'connector' as const })));
    const fromChannels = channelStates().flatMap((c) =>
      (c.requires ?? []).map((name) => ({ name, usedBy: c.label, kind: 'channel' as const })));
    const fromSources = sourceStates().flatMap((s) =>
      [...s.requires, ...(s.optional ?? [])].map((name) => ({ name, usedBy: s.label, kind: 'source' as const })));
    // Providers too. Perplexity was registered as a role-chain provider and
    // nowhere else, so the settings screen showed "needs PERPLEXITY_API_KEY"
    // with no field anywhere to put it in. Anything that can be asked for a
    // credential has to be able to receive one.
    const fromProviders = listProviders().flatMap((p) =>
      p.missing.map((name) => ({ name, usedBy: p.label, kind: 'provider' as const })));

    // One row per credential, listing everything that wants it — several
    // connectors can share a key and asking for it twice would be silly.
    const byName = new Map<string, {
      name: string; usedBy: string[]; kind: string; source: string;
      what: string; where: string; url: string; billingUrl: string; secret: boolean;
    }>();
    for (const entry of [...fromConnectors, ...fromChannels, ...fromSources, ...fromProviders]) {
      const hint = hintFor(entry.name);
      const row = byName.get(entry.name) ?? {
        name: entry.name,
        usedBy: [] as string[],
        kind: entry.kind,
        source: secretSource(entry.name),
        what: hint.what,
        where: hint.where ?? '',
        // The page that issues it, and the page that shows what is left of it.
        // "Where do I get this" should be a click, not a search.
        url: hint.url ?? '',
        billingUrl: hint.billingUrl ?? '',
        secret: hint.secret,
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
    // Warn before storing, and report it back. A value pasted into the wrong
    // row is not an error — it might be deliberate — but silently accepting one
    // means the mistake surfaces later as an unexplained 401 in a stage that
    // has nothing to do with typing it.
    const warnings = warnAbout(values, storedSecrets());
    setSecrets(values);
    // Re-probe immediately: the point of typing a key is to find out whether it
    // works, and making someone press a second button to learn that is the same
    // failure as sending them to .env.
    res.json({ connectors: await checkConnectors(), warnings });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/** What the system would have said to real people, and did not.
 *
 *  Kept as its own surface rather than buried in each issue: the useful review
 *  question is "read everything we were about to post", not "click through
 *  twelve issues". */
/* ------------------------------------------------------------- schedule --
 *
 *  Listed with its next and last run, and what that run found. A schedule that
 *  only says when it will fire cannot tell you it has been firing into a wall
 *  for a week. */
/* -------------------------------------------------------------- credits --
 *
 *  What each provider has left. Retrieval is what this product costs, and while
 *  it is being demoed the free grants are the whole budget — so the number
 *  belongs on the screen, not in four separate vendor consoles. */
app.get('/api/credits', (_req, res) => res.json(listCredits()));

/* ------------------------------------------------------------- presence --
 *
 *  The footprint is an input, not a readout: a subreddit in it becomes a direct
 *  query against that subreddit on the next run, and a wrong entry sends every
 *  later stage somewhere useless. So it is editable, and the edits are rules
 *  rather than record changes — a channel deleted from one run would simply be
 *  found again by the next crawl. */
app.post('/api/scans/:id/presence', (req, res) => {
  const scan = store.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'no such scan' });
  const { url, action, official } = req.body as { url?: string; action?: string; official?: boolean };
  if (!url?.trim()) return res.status(400).json({ error: 'expected a url' });

  const key = store.companyKey(scan);
  if (action === 'block') {
    block(key, url);
    // Applied to the loaded scan too, so the panel reflects it without waiting
    // for a re-crawl that is minutes away and may not be run today.
    store.patch(scan.id, { profiles: applyOverrides(key, scan.profiles) });
  } else if (action === 'unblock') {
    unblock(key, url);
  } else {
    const profile = addProfile(key, url, official ?? true);
    if (!profile) return res.status(400).json({ error: `cannot read a channel out of "${url}"` });
    store.patch(scan.id, { profiles: applyOverrides(key, scan.profiles) });
  }

  res.json({ profiles: store.get(req.params.id)!.profiles, overrides: overridesFor(key) });
});

app.get('/api/scans/:id/presence', (req, res) => {
  const scan = store.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'no such scan' });
  res.json({ profiles: scan.profiles, overrides: overridesFor(store.companyKey(scan)) });
});

app.put('/api/credits/:provider', (req, res) => {
  const body = req.body as { unit?: 'dollars' | 'requests'; granted?: number | null; spent?: number };
  res.json({ ledger: setLedger(req.params.provider, body ?? {}), credits: listCredits() });
});

app.get('/api/schedule', (_req, res) => {
  res.json({ entries: listSchedule(), running: runningNow() });
});

app.put('/api/schedule', (req, res) => {
  const body = req.body as { input?: string };
  if (!body?.input?.trim()) return res.status(400).json({ error: 'expected an input to watch' });
  upsert({ ...(req.body as object), input: body.input.trim() } as Parameters<typeof upsert>[0]);
  res.json({ entries: listSchedule(), running: runningNow() });
});

app.delete('/api/schedule/:id', (req, res) => {
  if (!removeEntry(req.params.id)) return res.status(404).json({ error: 'no such schedule' });
  res.json({ entries: listSchedule(), running: runningNow() });
});

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
    if (Array.isArray(req.body.roles)) {
      changes.roles = req.body.roles.filter((r: unknown) => r === 'general' || r === 'coding');
    }

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
/** What a host actually serves.
 *
 *  The model id was a free-text box, and every way of getting it wrong is
 *  silent: `qwen3.8:27b` against a router that has never heard of it answers
 *  `all servers failed`, and a baseUrl missing its `/v1` answers 405. Both were
 *  live in this project's own config. The host will list its models if asked,
 *  so ask it rather than making somebody type from memory.
 *
 *  Reachability comes back too, because "which models" and "is it up" are the
 *  same question at the moment somebody is configuring one. */
app.get('/api/inference/models', async (req, res) => {
  const key = String(req.query.host ?? '').trim();
  try {
    // From the config rather than from inferenceHosts(), which deliberately
    // withholds the key so it can be sent to a browser. This runs server-side
    // and the key never leaves it.
    const host = key ? (inferenceConfig().value.hosts ?? {})[key] : undefined;
    const baseUrl = (String(req.query.baseUrl ?? '') || host?.baseUrl || '').replace(/\/$/, '');
    if (!baseUrl) return res.status(400).json({ error: 'no baseUrl to ask' });

    const response = await fetch(`${baseUrl}/models`, {
      headers: host?.apiKey ? { Authorization: `Bearer ${host.apiKey}` } : {},
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      return res.json({ reachable: false, error: `${response.status}`, models: [] });
    }
    const body = (await response.json()) as { data?: { id?: string }[] };
    const models = (body.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
    res.json({ reachable: true, models });
  } catch (error) {
    res.json({
      reachable: false,
      models: [],
      error: error instanceof Error ? error.message.slice(0, 140) : 'could not reach it',
    });
  }
});

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
    const changes: Parameters<typeof patchConnector>[1] = {};
    if (typeof req.body?.url === 'string') changes.url = req.body.url.trim();
    if (typeof req.body?.enabled === 'boolean') changes.enabled = req.body.enabled;
    if (req.body?.bindings && typeof req.body.bindings === 'object') {
      const bindings: Partial<Record<ConnectorRole, RoleBinding>> = {};
      for (const [role, value] of Object.entries(req.body.bindings as Record<string, RoleBinding>)) {
        if (!(ROLES as readonly string[]).includes(role)) {
          return res.status(400).json({ error: `"${role}" is not a role` });
        }
        // A binding with no tool or no argument is not a binding — it would be
        // stored, satisfy connectorsForRole, and then call undefined.
        if (!value?.tool?.trim() || !value?.arg?.trim()) {
          return res.status(400).json({ error: `the ${role} binding needs both a tool and an argument name` });
        }
        bindings[role as ConnectorRole] = {
          tool: value.tool.trim(), arg: value.arg.trim(), ...(value.extra ? { extra: value.extra } : {}),
        };
      }
      changes.bindings = bindings;
    }
    patchConnector(req.params.name, changes);
    // Re-probe everything rather than just this row: enabling one connector
    // changes what the list means, and a stale neighbour is confusing.
    res.json(await checkConnectors());
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/** The role catalogue, so the settings screen can explain what picking one
 *  does rather than showing five bare words. */
/** The role chains, in order, plus every provider that could join one.
 *
 *  One payload rather than three requests: the screen is a set of ordered
 *  lists and an "add" menu of what is not in them, and those are the same
 *  question asked twice. */
app.get('/api/roles', (_req, res) => {
  res.json({
    roles: ROLES.map((role) => ({ ...ROLE_INFO[role], chain: chainFor(role) })),
    providers: listProviders(),
  });
});

/** Reorder a role's chain, or change who is in it.
 *
 *  The array is the complete membership in priority order — first choice
 *  first — so dragging a row out of the list removes it from the role, and
 *  dragging one up genuinely changes which provider is asked first. */
app.put('/api/roles/:role', (req, res) => {
  const role = req.params.role as ConnectorRole;
  if (!(ROLES as readonly string[]).includes(role)) {
    return res.status(400).json({ error: `no role called "${role}"` });
  }
  if (!Array.isArray(req.body?.chain)) {
    return res.status(400).json({ error: 'chain must be an array of provider ids, best first' });
  }
  try {
    setRoleChain(role, req.body.chain.map(String));
    res.json({ roles: ROLES.map((r) => ({ ...ROLE_INFO[r], chain: chainFor(r) })), providers: listProviders() });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/** What this process has actually spent on connectors, per tool.
 *
 *  Counts requests, not money — the vendor is the authority on the bill. What
 *  it answers is the question a dashboard cannot: which tool the budget went
 *  on, how much of it went on calls that errored, and whether a metered
 *  provider is being used at all. Resets when the server restarts, because it
 *  is about this run rather than the month. */
app.get('/api/connectors/usage', (_req, res) => {
  const rows = toolUsage();
  res.json({
    since: process.uptime(),
    total: rows.reduce((sum, row) => sum + row.calls, 0),
    errors: rows.reduce((sum, row) => sum + row.errors, 0),
    tools: rows,
  });
});

/** Install an MCP server, then dial it and report what it offers.
 *
 *  Adding and probing are separate inside (see addConnector) but one action out
 *  here, because the question a person actually has when they paste a URL is
 *  "did that work, and what can it do" — and answering it needs the tool list
 *  anyway to suggest role bindings. A server that does not answer is still
 *  saved; the response says so. */
app.post('/api/connectors', async (req, res) => {
  try {
    const body = req.body ?? {};
    const connector = addConnector({
      name: String(body.name ?? '').trim(),
      url: String(body.url ?? '').trim(),
      description: typeof body.description === 'string' ? body.description : undefined,
      requires: Array.isArray(body.requires) ? body.requires.map(String) : undefined,
    });
    res.json({ connector, ...(await inspectConnector(connector.name)) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete('/api/connectors/:name', async (req, res) => {
  try {
    removeConnector(req.params.name);
    res.json(await checkConnectors());
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/** What one server offers, and which of its tools would serve each role.
 *
 *  The suggestion is a heuristic over tool names and their declared arguments,
 *  and it is shown for confirmation rather than applied. A tool bound to the
 *  wrong role fails loudly; a query passed in the wrong argument does not —
 *  most servers answer that with something plausible and empty. */
async function inspectConnector(name: string) {
  const connector = enabledConnectors().find((c) => c.name === name);
  if (!connector) return { reachable: false, error: 'not in the config', tools: [], suggested: {} };

  const missing = missingCredentials(connector);
  if (missing.length) {
    return { reachable: false, error: `needs ${missing.join(', ')}`, tools: [], suggested: {} };
  }

  try {
    const tools = await listTools(connector);
    // Cached on the connector so the role screen can hint at what a server
    // plausibly does without dialling every server on every page load.
    try {
      patchConnector(name, { tools: tools.map((t: McpTool) => t.name) });
    } catch {
      // A config that will not take the cache is not a reason to fail the
      // inspection the caller actually asked for.
    }
    const suggested: Partial<Record<ConnectorRole, RoleBinding>> = {};
    for (const role of ROLES) {
      const tool = guessTool(role, tools);
      if (!tool) continue;
      const schema = tools.find((t: McpTool) => t.name === tool)?.inputSchema;
      suggested[role] = { tool, arg: guessArg(role, schema) };
    }
    return {
      reachable: true,
      tools: tools.map((t: McpTool) => ({
        name: t.name,
        description: (t.description ?? '').slice(0, 200),
        args: Object.keys(t.inputSchema?.properties ?? {}),
      })),
      suggested,
    };
  } catch (error) {
    return {
      reachable: false,
      error: error instanceof Error ? error.message.slice(0, 200) : String(error),
      tools: [],
      suggested: {},
    };
  }
}

app.get('/api/connectors/:name/tools', async (req, res) => {
  res.json(await inspectConnector(req.params.name));
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
/* The Reddit-specific settings routes that used to live here are gone.
 *
 * They backed a Reddit-only form in the settings panel, which was replaced when
 * credentials moved inline into the row that needs them. What made removing
 * them worth doing rather than merely tidy: the form displayed each secret
 * masked as `abc…yz`, loaded that display value into its own input, and saved
 * it back — so pressing Save overwrote the real client id with the six
 * characters of its own mask. Reddit then failed with a latin-1 encoding error
 * from deep inside PRAW, which reads like anything but "the UI ate the key".
 *
 * Reddit credentials are now ordinary credentials, entered under Direct
 * sources and read through secret(). See app/server/sources/index.ts.
 */

app.get('/api/scans/:id', (req, res) => {
  const scan = store.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'no such scan' });
  res.json(scan);
});

const STAGE_KEYS: Stage[] = STAGES.map((s) => s.key);


/** `?languages=zh,ja` — validated against the packs that exist, so a typo is
 *  dropped rather than silently producing a language nobody searches in.
 *  Undefined when the parameter is absent, which is different from an empty
 *  list: absent means "leave it as it was", empty means "English only". */
function parseLanguages(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  const known = new Set(LANGUAGES.map((l) => l.code));
  return String(raw).split(',').map((code) => code.trim()).filter((code) => known.has(code));
}

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

  // One writer per scan. Racing a stage rerun would not interleave, it would
  // overwrite — see the note on store.claim.
  const lock = store.claim(req.params.id, 'full scan');
  if (!lock.ok) {
    // Refused over the stream rather than as a 409: the client is an
    // EventSource, which cannot read a response body and would show this as a
    // bare connection error with nothing to act on.
    const send = openStream(res, () => {});
    send({
      type: 'error',
      kind: 'busy',
      message: `This scan has been running for ${store.heldFor(lock.held)}s already, `
        + 'so a second run was not started on top of it.',
    });
    return res.end();
  }

  // Reuse the record the POST created, so its createdAt — and its position in
  // the rail — does not jump when the stream opens.
  const existing = store.get(req.params.id);

  // What the last run of this company already worked out.
  //
  // A daily run mints a new scan id, so `existing` is an empty shell and
  // everything static would be re-derived from nothing every morning: the
  // subject re-resolved with a model call and a search, and the footprint
  // re-crawled before anything that actually changes got a look in. The
  // footprint and the resolved subject belong to the company, not to the run.
  //
  // Only from a run that got far enough to have them, and never a fixture.
  const previous = [...store.history(req.params.id)]
    .reverse()
    .find((run) => run.id !== req.params.id && !run.fixture && (run.profiles?.length ?? 0) > 0);

  const scan: Scan = {
    id: req.params.id,
    input: existing?.input ?? raw,
    company: cleanName(raw),
    site: siteOf(raw),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    startedAt: new Date().toISOString(),
    status: 'running',
    stage: 'queued',
    depth: req.query.depth === 'deep' ? 'deep' : (existing?.depth ?? 'normal'),
    // Carried over from the stored record when the request does not say.
    // Languages are a property of what is being watched, not of one run, so a
    // rescan should not quietly stop looking in Japanese.
    languages: parseLanguages(req.query.languages) ?? existing?.languages ?? previous?.languages ?? [],
    ...(existing?.subject ?? previous?.subject ? { subject: existing?.subject ?? previous?.subject } : {}),
    profiles: existing?.profiles?.length ? existing.profiles : (previous?.profiles ?? []),
    mentions: [],
    issues: [],
    abuse: [],
    buzz: [],
    topics: [],
    migrations: [],
    reviews: [],
    feed: [],
    log: [],
    timings: {},
    verdict: '',
    net: { now: 0, delta: 0 },
  };
  store.put(scan);

  const signal = cancel.begin(req.params.id);
  // One budget per run, not per process — otherwise the second scan of a
  // session inherits an already-spent one.
  resetSearchBudget();

  const send = openStream(res, () => {});

  try {
    await performScan(scan, send, signal);
  } finally {
    cancel.end(req.params.id);
    store.release(req.params.id, 'full scan');
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

  const what = `${next} rerun`;
  const lock = store.claim(req.params.id, what);
  if (!lock.ok) {
    const send = openStream(res, () => {});
    send({
      type: 'error',
      stage: next,
      kind: 'busy',
      message: `The ${lock.held.what.replace(/ rerun$/, ' step')} of this scan has been running for `
        + `${store.heldFor(lock.held)}s already. Starting another underneath it would overwrite `
        + 'whatever it writes when it finishes.',
    });
    return res.end();
  }

  // A stage rerun can dig even when the run that produced the scan did not —
  // "search deeper" is a thing you decide after seeing a thin result, not
  // before.
  if (req.query.depth === 'deep' || req.query.depth === 'normal') {
    scan.depth = req.query.depth;
    store.patch(req.params.id, { depth: scan.depth });
  }
  // Which source to go deep on, when the coverage grid asked for one. Checked
  // against the venues we know rather than passed through, so a stray value
  // cannot quietly mean "no source" and look like a normal run.
  const DIGGABLE = new Set(['hackernews', 'github', 'reddit']);
  const dig = DIGGABLE.has(String(req.query.dig)) ? String(req.query.dig) : undefined;

  const asked = parseLanguages(req.query.languages);
  if (asked) {
    scan.languages = asked;
    store.patch(req.params.id, { languages: asked });
  }

  // Stamped before anything runs, so the elapsed clock measures this piece of
  // work rather than whatever the record remembers.
  store.patch(req.params.id, { startedAt: new Date().toISOString(), status: 'running' });

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

  const signal = cancel.begin(req.params.id);

  try {
    const servers = availableConnectors();
    scan.status = 'running';
    scan.stage = next;
    store.put(scan);
    await runStage({ scan, log, send, signal, dig }, next);
    scan.status = 'done';
    scan.stage = 'done';
    store.put(scan);
    send({ type: 'patch', scan: { status: 'done', stage: 'done' } });
    send({ type: 'done', scan });
  } catch (error) {
    if (wasCancelled(error)) {
      log('warn', `cancelled at ${next} — keeping what was collected`);
      store.patch(req.params.id, { status: 'cancelled', stage: next });
      send({ type: 'patch', scan: { status: 'cancelled', stage: next } });
      send({ type: 'done', scan });
      return;
    }
    const raw = error instanceof Error ? error.message : String(error);
    const { message, detail, kind } = explainFailure(next, raw);
    log('error', `failed at ${next}: ${raw}`);
    store.patch(req.params.id, {
      status: 'error',
      stage: next,
      failedStage: next,
      error: message,
      errorDetail: detail,
      errorKind: kind,
    });
    send({ type: 'error', message, stage: next, detail, kind });
  } finally {
    cancel.end(req.params.id);
    store.release(req.params.id, what);
    res.end();
  }
});

/** Mint a scan and persist it immediately as queued.
 *
 *  It used to only return an id, and the record was created later when the
 *  browser opened the event stream. That is a race the dashboard always lost:
 *  it asked for the run list the moment the POST returned, the store did not
 *  have the scan yet, and the new company did not appear in the rail until a
 *  manual refresh. Creating it here means the row exists before anything is
 *  streamed. */
app.post('/api/scans', (req, res) => {
  const raw = String(req.body?.company ?? '').trim();
  const id = randomUUID().slice(0, 8);
  if (!raw) return res.json({ id });

  store.put({
    id,
    input: raw,
    company: cleanName(raw),
    site: siteOf(raw),
    createdAt: new Date().toISOString(),
    status: 'running',
    stage: 'queued',
    profiles: [], mentions: [], issues: [], abuse: [], buzz: [],
    topics: [], migrations: [], reviews: [], feed: [], log: [], timings: {},
    verdict: '',
    net: { now: 0, delta: 0 },
  });
  res.json({ id });
});

/** Remove a scan, and every other attempt at the same company, since that is
 *  what one row in the sidebar stands for. Deliberately explicit about how many
 *  records went: "removed 1" and "removed 4" are different events and the
 *  caller should be able to tell the user which happened. */
/** Stop a run that is already going.
 *
 *  A signal, not a kill. The run stops at its next checkpoint — between stages,
 *  before each search, or when the in-flight request it is waiting on drops —
 *  and keeps everything it collected up to that point. Tearing the process down
 *  mid-stage would leave a half-written scan, which is worse than waiting a few
 *  seconds for it to stop tidily.
 *
 *  Returns whether anything was actually running, so the dashboard can say "it
 *  had already finished" rather than claiming to have stopped something. */
/** What is known about this company's project, and where each fact came from.
 *
 *  Returned as three layers rather than one merged answer — specified,
 *  discovered, effective — because the interesting question on this screen is
 *  not only "what will be used" but "is that because I said so, or because
 *  something guessed". A resolver is right most of the time and confidently
 *  wrong the rest, and the difference has to be visible before somebody trusts
 *  a diagnosis built on it. */
/** How this company's runs compare, and what moved between them.
 *
 *  Keyed on the run's own timestamp rather than on when anything was written —
 *  see the note in series.ts. This is the daily-check surface: what is new
 *  since yesterday, what is still open, what went away. */
app.get('/api/scans/:id/series', (req, res) => {
  const runs = store.history(req.params.id);
  if (runs.length === 0) return res.status(404).json({ error: 'no such scan' });
  res.json(buildSeries(runs));
});

app.get('/api/scans/:id/project', (req, res) => {
  const scan = store.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'no such scan' });
  res.json({ ...projectFor(scan.company, { repo: scan.subject?.repo }), workspace: scan.workspace ?? null });
});

/** Specify any of them by hand. An empty value clears the override and lets
 *  discovery answer again, which is why this is a patch and not a put. */
app.put('/api/scans/:id/project', (req, res) => {
  const scan = store.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'no such scan' });

  const body = req.body ?? {};
  const changes: Record<string, string> = {};
  for (const field of ['url', 'tracker', 'testCommand'] as const) {
    if (typeof body[field] === 'string') changes[field] = body[field];
  }
  if (Object.keys(changes).length === 0) {
    return res.status(400).json({ error: 'nothing to change' });
  }

  try {
    const project = patchProject(scan.company, changes);
    res.json({ ...project, workspace: scan.workspace ?? null });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/scans/:id/cancel', (req, res) => {
  const scan = store.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'no such scan' });
  const stopping = cancel.cancel(req.params.id);
  res.json({
    stopping,
    message: stopping
      ? 'Stopping — it will finish the request it is on and keep what it has collected.'
      : 'Nothing was running on this scan.',
  });
});

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
      // The issue rides back with the result so the caller does not have to
      // refetch to see the ledger entry it just created.
      return res.json({ draft, ...result, issue });
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
        await recordLoopStep(scan, issue, event);
      }
      return res.json({ draft, ...result });
    }

    res.json({ draft, sent: false });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'reply drafting failed' });
  }
});

/** Read the project's source and say where the defect likely lives.
 *
 *  Long-running by nature — a checkout may need cloning, then the model reads
 *  several files — so the response is held rather than streamed. Progress is
 *  already visible: every agent call lands on /api/agents/stream as it happens. */
app.post('/api/scans/:id/issues/:issueId/diagnose', async (req, res) => {
  const scan = store.get(req.params.id);
  const issue = scan?.issues.find((i) => i.id === req.params.issueId);
  if (!scan || !issue) return res.status(404).json({ error: 'no such issue' });

  const trail: string[] = [];
  const emit = (level: 'info' | 'warn', text: string) => trail.push(`[${level}] ${text}`);

  try {
    const { path: repo } = await ensureCheckout(scan.company, emit, scan.subject?.repo, scan.workspace);
    const result = await diagnoseIssue(scan, issue, repo, emit);
    issue.diagnosis = { ...result, at: new Date().toISOString() };
    // On the ledger, not just in the record. Reading the source against a
    // stranger's complaint is a step somebody took on their behalf, and the
    // audit trail is the point of this feature — an issue should read top to
    // bottom as what was done, when, and what it concluded.
    issue.loop = [...(issue.loop ?? []), {
      id: randomUUID().slice(0, 8),
      step: 'reproduced',
      actor: 'agent',
      at: issue.diagnosis.at,
      human: false,
      summary: `Read the source: ${result.verdict} (${result.confidence} confidence). `
        + `${result.searched.hits} matching lines across ${result.searched.files.length} files. `
        + result.likelyCause.slice(0, 200),
    }];
    store.put(scan);
    res.json({ diagnosis: issue.diagnosis, log: trail });
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? error.message : 'diagnosis failed',
      log: trail,
    });
  }
});

/** Fork it, read it, patch it, and publish the record — streamed.
 *
 *  One route because it is one action. The separate diagnose and fix endpoints
 *  stay, for anyone who wants a single step, but this is the one the button
 *  calls: minutes of work with visible progress, rather than four controls in
 *  an order you have to know. */
app.get('/api/scans/:id/issues/:issueId/investigate/stream', async (req, res) => {
  const scan = store.get(req.params.id);
  const issue = scan?.issues.find((i) => i.id === req.params.issueId);
  if (!scan || !issue) return res.status(404).json({ error: 'no such issue' });

  const lock = store.claim(req.params.id, 'investigation');
  const send = openStream(res, () => {});
  if (!lock.ok) {
    send({ type: 'error', kind: 'busy', message: `This scan is busy (${lock.held.what}, ${store.heldFor(lock.held)}s).` });
    return res.end();
  }

  const signal = cancel.begin(req.params.id);
  const log: Log = (level, text) => {
    scan.log.push({ at: new Date().toISOString(), level, stage: 'health', text });
    send({ type: 'log', line: scan.log.at(-1)! });
  };

  try {
    await withRunContext({ scanId: scan.id, stage: 'health', signal }, () => investigate(
      scan, issue, log,
      (progress) => send({ type: 'log', line: {
        at: new Date().toISOString(), level: 'info', stage: 'health',
        text: `[${progress.step}] ${progress.note}`,
      } }),
    ));
    store.put(scan);
    send({ type: 'done', scan });
  } catch (error) {
    if (wasCancelled(error)) {
      store.put(scan);
      send({ type: 'error', kind: 'busy', message: 'Investigation cancelled — what it found so far is kept.' });
    } else {
      const raw = describeError(error);
      store.put(scan);
      send({ type: 'error', message: raw.slice(0, 300), stage: 'health' });
    }
  } finally {
    cancel.end(req.params.id);
    store.release(req.params.id, 'investigation');
    res.end();
  }
});

/** Write the patch and run the tests, in a throwaway copy.
 *
 *  Nothing is committed, pushed or applied to the configured checkout. The
 *  answer is a diff plus a test result, and the caller decides what to do with
 *  it. Requires a diagnosis first: patching without one is guessing. */
app.post('/api/scans/:id/issues/:issueId/fix', async (req, res) => {
  const scan = store.get(req.params.id);
  const issue = scan?.issues.find((i) => i.id === req.params.issueId);
  if (!scan || !issue) return res.status(404).json({ error: 'no such issue' });
  if (!issue.diagnosis) return res.status(400).json({ error: 'diagnose this issue first' });

  const trail: string[] = [];
  const emit = (level: 'info' | 'warn', text: string) => trail.push(`[${level}] ${text}`);

  try {
    const { path: repo } = await ensureCheckout(scan.company, emit, scan.subject?.repo, scan.workspace);
    const result = await fixIssue(scan, issue, issue.diagnosis, repo, emit);
    issue.fix = { ...result, at: new Date().toISOString() };
    const proven = result.provesTheBug.checked && result.provesTheBug.failedOnOriginal;
    issue.loop = [...(issue.loop ?? []), {
      id: randomUUID().slice(0, 8),
      step: result.applied && result.tests.passed ? 'fixed' : 'reproduced',
      actor: 'agent',
      at: issue.fix.at,
      human: false,
      summary: result.applied && result.tests.passed
        ? `Patched ${result.files.length} file(s) in ${result.attempts} attempt(s); `
          + `\`${result.tests.command}\` passes. `
          + (proven ? 'The new test fails against the original code, so it catches the bug.'
            : 'The new test does not fail against the original code, so it proves nothing yet.')
        : `Tried ${result.attempts} time(s) and did not land a working patch. ${result.notes.slice(0, 160)}`,
      ref: { label: `${result.attempts} attempt(s)` },
    }];
    store.put(scan);
    res.json({ fix: issue.fix, log: trail });
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? error.message : 'fix failed',
      log: trail,
    });
  }
});

/** Fork the subject's repository, and point ticketing at the fork.
 *
 *  The one action that makes filing safe. Everything this pipeline writes —
 *  tickets, comments, pull requests — goes to a fork under the authenticated
 *  account, never to the project itself. */
app.post('/api/scans/:id/fork', async (req, res) => {
  const scan = store.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'no such scan' });

  const upstream = scan.subject?.repo;
  if (!upstream) return res.status(400).json({ error: 'this scan has no repository to fork' });

  const trail: string[] = [];
  try {
    const fork = await ensureFork(upstream, (level, text) => trail.push(`[${level}] ${text}`));
    scan.fork = fork.fullName;
    store.put(scan);
    res.json({ fork, log: trail });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'fork failed', log: trail });
  }
});

/** Open a pull request on the fork with a verified fix. */
app.post('/api/scans/:id/issues/:issueId/pr', async (req, res) => {
  const scan = store.get(req.params.id);
  const issue = scan?.issues.find((i) => i.id === req.params.issueId);
  if (!scan || !issue) return res.status(404).json({ error: 'no such issue' });
  if (!issue.fix?.files?.length) return res.status(400).json({ error: 'write a fix first' });
  if (!issue.fix.tests.passed) {
    return res.status(400).json({ error: 'the tests did not pass — not opening a pull request for it' });
  }

  const trail: string[] = [];
  try {
    const pr = await openPullRequest(
      scan,
      issue.fix.files.map((f) => ({ path: f.path, contents: f.contents })),
      issue.title,
      [
        issue.fix.summary,
        '',
        `Reported publicly: ${issue.summary}`,
        `Impact: ${issue.impact}`,
        '',
        `Tests: \`${issue.fix.tests.command}\` — ${issue.fix.tests.passed ? 'pass' : 'fail'}`,
        `Regression test checked against the original code: ${issue.fix.provesTheBug.detail}`,
        '',
        '_Opened automatically against a fork. Not submitted to the upstream project._',
      ].join('\n'),
      (level, text) => trail.push(`[${level}] ${text}`),
    );
    issue.loop = [...(issue.loop ?? []), {
      id: randomUUID().slice(0, 8),
      step: 'fixed',
      actor: 'agent',
      at: new Date().toISOString(),
      human: false,
      summary: `Pull request #${pr.number} opened on the fork.`,
      ref: { label: `#${pr.number}`, url: pr.url },
    }];
    store.put(scan);
    // The issue goes back too, so the dashboard shows the new ledger entry
    // without a refetch — the pull request is a step in the loop, not a
    // side-effect to be discovered later.
    res.json({ pr, issue, log: trail });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'pull request failed', log: trail });
  }
});

/** Which companies have a repository configured, so the dashboard can offer
 *  diagnosis only where there is source to read. */
app.get('/api/repos', (_req, res) => {
  reloadRepos();
  res.json(repoConfig().value.repos.map((r) => ({
    company: r.company,
    source: r.path ?? r.url ?? '',
  })));
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
  for (const event of issue.loop.slice(-2)) await recordLoopStep(scan, issue, event);

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
app.listen(port, host, () => {
  console.log(`whisperer on http://${host}:${port}`);
  // Started with the server and dying with it, on purpose. Say out loud what
  // is armed, so a scan that appears overnight has a visible cause.
  startScheduler();
  const armed = listSchedule().filter((entry) => entry.enabled);
  console.log(armed.length
    ? `scheduled: ${armed.map((e) => `${e.input} ${e.cadence} at ${String(e.hour).padStart(2, '0')}:00`).join(', ')}`
    : 'scheduled: nothing — add one under /api/schedule');
});
