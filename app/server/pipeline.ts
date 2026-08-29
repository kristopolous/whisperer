import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { TrueForge } from '@truefoundry/trueforge-sdk';
import type {
  AbuseFinding, BuzzPoint, Issue, LogLevel, Mention, Profile, Scan, ScanEvent, Stage, Venue,
} from '../shared/types.ts';
import { abuseSchema, buzzSchema, healthSchema, mentionsSchema, strictify } from './schemas.ts';

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '../..');
const SKILL = path.join(ROOT, 'skills/extract-social-media/scripts');

export const client = new TrueForge({
  baseUrl: process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790',
  timeoutInSeconds: 900,
  token: process.env.TRUEFORGE_TOKEN,
});

const MODEL = process.env.TRUEFORGE_MODEL ?? 'openai/gpt-5-5';

export type Log = (level: LogLevel, text: string) => void;
type Emit = Log;

/** Search backends in the order we want them used.
 *
 *  Bright Data first: it is the paid, unmetered path and does not rate-limit the
 *  way the shared Exa endpoint does, which was returning 429 through most of a
 *  run. Exa stays as a fallback rather than being removed — when Bright Data is
 *  not configured, some search is better than none.
 */
const SEARCH_PREFERENCE = ['bright-data', 'reddit', 'hn', 'exa'];

const orderServers = (available: string[], wanted: string[]) =>
  SEARCH_PREFERENCE.filter((name) => wanted.includes(name) && available.includes(name));

/** Which connectors this instance actually has, so a missing one degrades to a
 *  narrower search instead of a failed turn. */
export async function availableServers(): Promise<string[]> {
  try {
    const { data } = await client.mcpServers.list();
    return data.map((s) => s.name);
  } catch {
    return [];
  }
}

/** One agent turn, held to a JSON schema, returned parsed.
 *
 *  `effort` is the reasoning budget: searching is worth thinking about, bulk
 *  scoring of a corpus is not. Providers that don't take the parameter ignore it.
 */
async function askJson<T>(opts: {
  instructions: string;
  prompt: string;
  schema: unknown;
  servers?: string[];
  effort?: 'none' | 'low' | 'medium' | 'high';
  emit: Emit;
}): Promise<T> {
  let servers = opts.servers ?? [];

  // A connector can be registered with TrueForge and still be broken — no
  // credentials, an expired token, the container down. TrueForge attaches every
  // server eagerly at turn start, so one broken connector otherwise takes the
  // whole turn down before the model gets to try anything. Strip it and retry
  // rather than losing the stage over a server nothing here is even using yet.
  for (let attempt = 0; attempt <= servers.length; attempt++) {
    try {
      return await attemptJson<T>({ ...opts, servers });
    } catch (error) {
      const broken = error instanceof Error
        && error.message.match(/Failed to connect to remote MCP server '([\w-]+)'/)?.[1];
      if (!broken || !servers.includes(broken)) throw error;
      opts.emit('warn', `${broken} is registered but unreachable — continuing without it`);
      servers = servers.filter((s) => s !== broken);
    }
  }
  throw new Error('every connector for this stage failed to connect');
}

async function attemptJson<T>(opts: {
  instructions: string;
  prompt: string;
  schema: unknown;
  servers: string[];
  effort?: 'none' | 'low' | 'medium' | 'high';
  emit: Emit;
}): Promise<T> {
  const { data: session } = await client.sessions.create({
    agent: {
      spec: {
        model: { name: MODEL, params: { reasoningEffort: opts.effort ?? 'low' } },
        instructions: opts.instructions,
        mcpServers: opts.servers.map((name) => ({
          name,
          preload: true,
          // Everything here is read-only research; stopping for approval would
          // strand the pipeline behind a prompt nobody is watching.
          requireApprovalForTools: [],
        })),
        responseFormat: { type: 'json_schema', jsonSchema: strictify(opts.schema) as never },
        config: { askUserQuestions: { enabled: false } },
      },
    },
  });

  const stream = await client.sessions.createTurnStream(session.id, {
    input: [{ type: 'user.message', content: opts.prompt }],
  });

  let text = '';
  // Tool calls arrive on a model.message before their response, so hold the names
  // by call id and report each result against the tool that produced it.
  const toolNames = new Map<string, string>();

  for await (const { data: event } of stream.withMetadata()) {
    if (event.type === 'model.message.delta' && event.content) text += event.content;

    if (event.type === 'model.message') {
      for (const call of event.toolCalls ?? []) {
        if (call.id && call.function?.name) {
          toolNames.set(call.id, call.function.name);
          opts.emit('tool', `calling ${call.function.name}`);
        }
      }
    }

    if (event.type === 'tool.response') {
      const name = toolNames.get(event.toolCallId) ?? 'tool';
      const failed = /"error"|failed|Max retries|\b(4\d\d|5\d\d)\b/.test(event.content.slice(0, 200));
      opts.emit(
        failed ? 'warn' : 'tool',
        failed
          ? `${name} failed — ${summarizeFailure(event.content)}`
          : `${name} returned ${formatBytes(event.content.length)}`,
      );
    }

    if (event.type === 'mcp.auth_required') {
      for (const server of event.mcpServers) opts.emit('warn', `${server.name} needs authorization`);
    }

    if (event.type === 'turn.done') {
      if (event.state.status === 'error') throw new Error(event.state.message);
      const output = event.state.status === 'done' ? event.state.output : null;
      if (output && typeof output.content === 'string' && output.content.length > text.length) {
        text = output.content;
      }
    }
  }
  return parseJson<T>(text);
}

const formatBytes = (n: number) => (n < 1024 ? `${n} B` : `${Math.round(n / 1024)} kB`);

/** Turn an MCP error blob into one readable clause. */
function summarizeFailure(content: string): string {
  const code = content.match(/"code"\s*:\s*(\d{3})/)?.[1];
  if (code === '429') return 'rate limited (429)';
  if (code) return `HTTP ${code}`;
  const message = content.match(/"(?:message|text)"\s*:\s*"([^"]{0,120})/)?.[1];
  return message?.replace(/\\n/g, ' ').trim() || 'no detail returned';
}

/** Retry a stage that failed for a transient reason.
 *
 *  A rate limit or a dropped transport is worth one more attempt; a schema
 *  rejection or a missing model is not, and retrying it just burns minutes.
 */
async function withRetry<T>(label: string, log: Log, fn: () => Promise<T>): Promise<T> {
  const transient = /429|rate.?limit|ECONNRESET|ETIMEDOUT|502|503|504|transport/i;
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!transient.test(message)) throw error;
    log('warn', `${label} hit a transient failure, retrying once — ${message.slice(0, 120)}`);
    return fn();
  }
}

/** Models wrap JSON in prose or fences often enough that this is not optional. */
function parseJson<T>(raw: string): T {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.search(/[{[]/);
  if (start === -1) throw new Error(`no JSON in model output: ${raw.slice(0, 200)}`);
  const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
  return JSON.parse(body.slice(start, end + 1)) as T;
}

/** Run a command with `input` on its stdin and collect stdout. */
function pipeThrough(command: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let out = '', err = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { out += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${command} exited ${code}: ${err.slice(0, 300)}`)));
    child.stdin.end(input);
  });
}

/* ---------------------------------------------------------------- presence */

/** Runs the extract-social-media scripts directly.
 *
 *  The same code is published as a TrueForge skill, but skills execute in the
 *  agent's sandbox and this instance has no sandbox provider configured. Calling
 *  the scripts here keeps the stage working today; point the agent at the skill
 *  instead once a sandbox exists.
 */
export async function findPresence(site: string): Promise<Profile[]> {
  const { stdout: html } = await run('bash', [path.join(SKILL, 'scrape.sh'), site], {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
    encoding: 'utf8',
  });
  const stdout = await pipeThrough('python3', [path.join(SKILL, 'extract_social.py'), '--base', site], html);
  const parsed = JSON.parse(stdout) as { profiles: Profile[] };
  return parsed.profiles;
}

/** Turn "TrueFoundry" into a URL. A domain-shaped input is taken at its word. */
export async function resolveSite(company: string, servers: string[], emit: Emit): Promise<string> {
  const trimmed = company.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[\w-]+(\.[\w-]+)+$/.test(trimmed)) return `https://${trimmed}`;

  const { url } = await askJson<{ url: string }>({
    instructions: 'You find official websites. Answer with the homepage URL only.',
    prompt: `What is the official website of "${trimmed}"? Prefer the company's own domain over a directory listing, app store page, or social profile.`,
    schema: {
      name: 'site',
      schema: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } },
    },
    servers: orderServers(servers, ['bright-data', 'exa']),
    emit,
  });
  return url;
}

/* --------------------------------------------------------------- discovery */

const DISCOVERY_INSTRUCTIONS = `You find where people discuss software, and you report only what you actually found — read the real conversation, not just confirmation that a page exists.

A search result that only tells you a Reddit post or a tweet exists is not a finding. You have not covered a venue until you have opened the actual thread and pulled real comment or reply text from it. Do not stop at a list of links.

Method, in order:
1. Search each venue to get a list of candidate threads: Bright Data or Exa for general web search, the Reddit tool for Reddit, the Hacker News tool for HN, the X tool for X if it is available. Run several narrow queries rather than one broad one: plain mentions, "X vs", "X review", "X problems", "we use X", "switched from X".
2. For every candidate that looks like real discussion (not a listicle, not a press release), open it and read it:
   - Reddit: call get_post_comments on the post. Pull actual comment text, not the post title or body alone. A Reddit post with zero comments read is not a finding — go back and read them.
   - Hacker News: call get_story_info on the story. HN's signal is in the comment tree, not the submission title.
   - X: if you have an X search tool, fetch the actual post text and, where possible, the replies with real engagement — not just that a tweet exists.
   - Everything else (blogs, forums, review sites, YouTube comments): fetch the page and quote the actual passage, not a search-result snippet.
3. If a connector for a venue isn't available, search that venue through general web search instead (e.g. "site:reddit.com" or "site:news.ycombinator.com" via Exa/Bright Data) rather than skipping it.

The excerpt field must be a verbatim quote of what a real person wrote — at least one full sentence, taken from the comment or post body you actually opened. Never a paraphrase of the title, and never invented.

Rules:
- A tool failure is not the end of the search. If one returns a rate limit or an error, note it, move to the next venue, and report what the others gave you. Never stop the whole search because one backend was unavailable.
- Never invent a URL, a date, an engagement count, or a quote. Omit the field instead.
- Skip press releases, listicles, job postings and the company's own docs and blog.
- A submission with no comments read is not a discussion — either read the comments or leave it out.
- Aim for depth over breadth: 15 mentions you actually read in full beat 40 you only found the URL for.`;

export async function findMentions(
  company: string, site: string, profiles: Profile[], servers: string[], emit: Emit,
): Promise<Mention[]> {
  const usable = orderServers(servers, ['bright-data', 'exa', 'reddit', 'hn', 'x']);
  emit('info', `searching with ${usable.join(', ') || 'no connectors'}`);

  // The company's own accounts, found in the presence stage, are the sharpest
  // starting point: a real subreddit, a real handle, a real Discord — searching
  // those directly beats a blind web search for the name.
  const known = profiles.length
    ? `\n\nAccounts this company actually runs, useful as search anchors:\n${profiles.map((p) => `- ${p.platform}: ${p.url}`).join('\n')}`
    : '';

  const { mentions } = await withRetry('discovery', emit, () =>
    askJson<{ mentions: Omit<Mention, 'id' | 'sentiment' | 'score' | 'themes'>[] }>({
      instructions: DISCOVERY_INSTRUCTIONS,
      prompt: `Find third-party discussion of "${company}" (${site}). Cover Reddit and Hacker News thoroughly — open real threads and read real comments — then the wider web.${known}\n\nReturn up to 30 mentions, newest first. Depth over breadth: every mention must carry a verbatim quote you actually read.`,
      schema: mentionsSchema,
      servers: usable,
      effort: 'high',
      emit,
    }),
  );

  const seen = new Set<string>();
  return (mentions ?? [])
    .filter((m) => m?.url && !seen.has(m.url) && seen.add(m.url))
    .map((m) => ({
      ...m,
      id: randomUUID().slice(0, 8),
      date: normalizeDate(m.date),
      venue: (m.venue ?? 'other') as Venue,
      engagement: typeof m.engagement === 'number' ? m.engagement : null,
      sentiment: 'neutral' as const,
      score: 0,
      themes: [],
    }));
}

function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  // A date in the future is a hallucination, not news.
  if (parsed.getTime() > Date.now() + 86_400_000) return null;
  return parsed.toISOString();
}

/* -------------------------------------------------------------------- buzz */

export async function scoreBuzz(
  company: string, mentions: Mention[], emit: Emit,
): Promise<{ mentions: Mention[]; verdict: string }> {
  if (mentions.length === 0) return { mentions, verdict: 'No third-party discussion found to score.' };

  const corpus = mentions.map((m) => ({
    url: m.url, venue: m.venue, date: m.date, title: m.title, excerpt: m.excerpt.slice(0, 600),
  }));

  emit('info', `scoring ${mentions.length} mentions`);
  const { scored, verdict } = await withRetry('buzz', emit, () => askJson<{
    scored: { url: string; sentiment: Mention['sentiment']; score: number; themes?: string[] }[];
    verdict: string;
  }>({
    instructions: `You read public discussion and rate how people feel about a product.

Score each item from -1 (hostile) to +1 (delighted). 0 is genuinely neutral — a factual mention with no opinion — not a hedge for "unsure". Rate the commenters' view of the product, not the writing quality, and not the sentiment of the topic.

A frustrated user reporting a bug they want fixed is negative but engaged; mark it negative and tag the theme. Sarcasm reads as its opposite; judge intent.

Themes are two or three words, reusable across items ("cold starts", "pricing", "docs gaps"), not sentence fragments.

The verdict names the direction perception is moving and what is driving it, in one paragraph, citing what you saw rather than generalities.`,
    prompt: `Product: "${company}". Score every item and write the verdict.\n\n${JSON.stringify(corpus)}`,
    schema: buzzSchema,
    effort: 'low',
    emit,
  }));

  const byUrl = new Map((scored ?? []).map((s) => [s.url, s]));
  return {
    mentions: mentions.map((m) => {
      const hit = byUrl.get(m.url);
      if (!hit) return m;
      return {
        ...m,
        sentiment: hit.sentiment ?? 'neutral',
        score: clamp(hit.score ?? 0),
        themes: hit.themes ?? [],
      };
    }),
    verdict: verdict ?? '',
  };
}

const clamp = (n: number) => Math.max(-1, Math.min(1, Number(n) || 0));

/* ------------------------------------------------------------------ health */

export async function findIssues(
  company: string, mentions: Mention[], emit: Emit,
): Promise<Issue[]> {
  const complaints = mentions.filter((m) => m.score < 0.15);
  if (complaints.length === 0) return [];

  const corpus = complaints.map((m) => ({
    url: m.url, date: m.date, venue: m.venue, title: m.title, excerpt: m.excerpt.slice(0, 800),
  }));

  emit('info', `triaging ${complaints.length} negative or neutral mentions`);
  const { issues } = await withRetry('health', emit, () => askJson<{ issues: Omit<Issue, 'id' | 'status' | 'firstSeen' | 'lastSeen'>[] }>({
    instructions: `You triage public complaints into engineering issues.

Keep only problems in the product: bugs, broken or confusing interfaces, slowness, unreliability, missing documentation, billing surprises, and gaps people hit repeatedly. Discard opinion, pricing objections that are not billing bugs, competitor preference, and anything that is a support question rather than a defect.

Merge duplicates: one issue per underlying cause, with every supporting URL in evidence. An issue raised by four people is one issue.

Severity: critical = data loss, outage, or a security exposure; serious = a broken workflow with no workaround; warning = friction with a workaround; good = a resolved or minor nit.

The draft reply is written to the people who raised it. Acknowledge the specific thing that happened, say plainly what is being done about it, and stop. No apology theatre, no gratitude padding, no promised dates, no marketing.`,
    prompt: `Product: "${company}". Triage these complaints.\n\n${JSON.stringify(corpus)}`,
    schema: healthSchema,
    effort: 'medium',
    emit,
  }));

  const byUrl = new Map(mentions.map((m) => [m.url, m]));
  return (issues ?? []).map((issue) => {
    const dates = (issue.evidence ?? [])
      .map((url) => byUrl.get(url)?.date)
      .filter((d): d is string => Boolean(d))
      .sort();
    return {
      ...issue,
      id: randomUUID().slice(0, 8),
      evidence: (issue.evidence ?? []).map((url) => byUrl.get(url)?.id ?? url),
      firstSeen: dates[0] ?? null,
      lastSeen: dates.at(-1) ?? null,
      status: 'open' as const,
    };
  });
}

/* ------------------------------------------------------------------- abuse */

const ABUSE_INSTRUCTIONS = `You look for people abusing a brand's name, and you report only what the evidence supports.

What counts:
- **Impersonation** — accounts, servers or pages posing as the company, its founders or its support staff.
- **Phishing and credential theft** — lookalike domains, fake login or wallet-connect pages, "verify your account" flows.
- **Scams** — fake giveaways, airdrops, investment or refund schemes trading on the brand.
- **Fake support** — DMs offering help that route users off-platform, a pattern in Discord and Telegram communities.
- **Counterfeit** — resold licences, cracked builds, unauthorised listings.
- **Malware** — trojaned packages, installers or extensions using the name.
- **Spam and harassment** — coordinated posting, or brigading aimed at the company or its users.

Rules:
- Report only what you saw. A suspicion with no URL behind it is not a finding.
- A competitor being negative is not abuse. A frustrated user is not abuse. Criticism is not abuse.
- Do not name or target private individuals. Describe the account or the operation, not a person.
- Severity is about exposure: critical = users are losing money or credentials right now; serious = an active impersonation with reach; warning = a lookalike or a stale scam post; good = handled or negligible.
- The recommendation is one concrete action — which platform's report flow, which domain to register or contest, which community to warn.`;

export async function findAbuse(
  company: string, site: string, mentions: Mention[], servers: string[], emit: Emit,
): Promise<AbuseFinding[]> {
  const usable = orderServers(servers, ['bright-data', 'exa', 'reddit', 'hn']);
  if (usable.length === 0) {
    emit('warn', 'no search connector available — skipping the integrity sweep');
    return [];
  }
  emit('info', `sweeping for impersonation and scams with ${usable.join(', ')}`);

  const context = mentions.slice(0, 30).map((m) => ({ url: m.url, title: m.title, excerpt: m.excerpt.slice(0, 300) }));

  const { findings } = await withRetry('abuse', emit, () =>
    askJson<{ findings: Omit<AbuseFinding, 'id' | 'status' | 'firstSeen'>[] }>({
      instructions: ABUSE_INSTRUCTIONS,
      prompt: `Company: "${company}" (${site}).

Search for misuse of this brand: impersonating accounts and Discord/Telegram servers, lookalike domains, phishing pages, giveaway and airdrop scams, fake support, counterfeit or cracked distributions, and packages published under the name.

Check the obvious surfaces — the platforms the company itself is on, package registries, and any thread below that mentions being scammed or contacted by "support".

Discussion already collected:
${JSON.stringify(context)}`,
      schema: abuseSchema,
      servers: usable,
      effort: 'high',
      emit,
    }),
  );

  const byUrl = new Map(mentions.map((m) => [m.url, m]));
  return (findings ?? []).map((finding) => {
    const dates = (finding.evidence ?? [])
      .map((url) => byUrl.get(url)?.date)
      .filter((d): d is string => Boolean(d))
      .sort();
    return {
      ...finding,
      id: randomUUID().slice(0, 8),
      evidence: finding.evidence ?? [],
      locations: finding.locations ?? [],
      firstSeen: dates[0] ?? null,
      status: 'open' as const,
    };
  });
}

/* ------------------------------------------------------- derived timeseries */

/** Bucket by month. Computed here, not asked of the model — arithmetic is not
 *  something to leave to a language model. */
export function buildBuzz(mentions: Mention[]): BuzzPoint[] {
  const dated = mentions.filter((m) => m.date);
  if (dated.length === 0) return [];

  const buckets = new Map<string, Mention[]>();
  for (const m of dated) {
    const key = m.date!.slice(0, 7);
    buckets.set(key, [...(buckets.get(key) ?? []), m]);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, items]) => {
      const byVenue: Partial<Record<Venue, number>> = {};
      for (const m of items) byVenue[m.venue] = (byVenue[m.venue] ?? 0) + 1;
      return {
        bucket: `${bucket}-01`,
        score: items.reduce((sum, m) => sum + m.score, 0) / items.length,
        volume: items.length,
        byVenue,
      };
    });
}

/** Net sentiment now, and how far it moved across the window. */
export function netSentiment(buzz: BuzzPoint[]): Scan['net'] {
  if (buzz.length === 0) return { now: 0, delta: 0 };
  const weighted = (points: BuzzPoint[]) => {
    const volume = points.reduce((sum, p) => sum + p.volume, 0);
    return volume === 0 ? 0 : points.reduce((sum, p) => sum + p.score * p.volume, 0) / volume;
  };
  const half = Math.floor(buzz.length / 2);
  const recent = buzz.slice(-Math.max(1, buzz.length - half));
  const earlier = buzz.slice(0, Math.max(1, half));
  return { now: weighted(recent), delta: weighted(recent) - weighted(earlier) };
}
