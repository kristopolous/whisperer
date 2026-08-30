import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { TrueForge } from '@truefoundry/trueforge-sdk';
import type {
  AbuseFinding, BuzzPoint, FeedItem, Issue, LogLevel, Mention, Profile, Scan, ScanEvent, Stage, Venue,
} from '../shared/types.ts';
import { fetchAll } from './content.ts';
import { askJsonDirect } from './model.ts';
import { abuseSchema, buzzSchema, healthSchema, verdictSchema } from './schemas.ts';
import {
  braveSearch, braveSearchAll, isLexicalNoise, isOpinionBearing, platformOf, profileHandle, venueOf,
  type SearchHit,
} from './search.ts';

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '../..');
const SKILL = path.join(ROOT, 'skills/extract-social-media/scripts');

export const client = new TrueForge({
  baseUrl: process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790',
  timeoutInSeconds: 900,
  token: process.env.TRUEFORGE_TOKEN,
});

export type Log = (level: LogLevel, text: string) => void;
type Emit = Log;

/** Search backends in the order we want them used.
 *
 *  YouTube first: it's the primary feed source (videos + comments) and the fastest
 *  to report back. Then Bright Data, the paid unmetered path that does not
 *  rate-limit the way the shared Exa endpoint does, which was returning 429
 *  through most of a run. Exa stays as a fallback rather than being removed —
 *  when Bright Data is not configured, some search is better than none.
 */
const SEARCH_PREFERENCE = ['youtube', 'bright-data', 'exa', 'tiktok', 'brave'];

/** Connectors each stage asks for, in the order it wants them tried. Exported
 *  so src/agents.ts can attach the identical set to the saved-agent version of
 *  each stage — one list, not two copies that can drift.
 *
 *  exa is deliberately absent: the shared Exa endpoint has been returning empty
 *  results and 429s for a whole day, and plumbing a broken connector into every
 *  stage just makes turns fail and pages come back blank. The other search
 *  connectors cover the same ground. */
export const PRESENCE_SERVERS = ['x', 'exa', 'youtube', 'tiktok', 'bright-data', 'brave'];
export const DISCOVERY_SERVERS = ['x', 'exa', 'youtube', 'tiktok', 'bright-data', 'brave'];
export const FEED_SERVERS = ['youtube', 'bright-data', 'x', 'exa', 'tiktok', 'brave'];
export const ABUSE_SERVERS = ['bright-data', 'brave', 'exa', 'youtube', 'tiktok'];

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

/** One agent turn against a saved TrueForge agent, held to the agent's own JSON
 *  schema, returned parsed.
 *
 *  Each pipeline stage is a named agent registered by `npm run setup` (see
 *  src/agents.ts) — instructions, connectors, model and responseFormat are baked
 *  into the save, and the only per-run input is the prompt. These are the same
 *  agents you can fire from the TrueForge chat UI or from another agent, so
 *  Whisperer's stages aren't some private inline spec nobody else can see or
 *  reuse. A connector that was up at setup time but is now dead surfaces as an
 *  ordinary isError tool result the model routes around (`preload: false` is part
 *  of every saved agent), instead of an eager failure at session start.
 */
async function askJson<T>(opts: { agent: string; prompt: string; emit: Emit }): Promise<T> {
  const { data: session } = await client.sessions.create({ agent: { name: opts.agent } });

  const stream = await client.sessions.createTurnStream(session.id, {
    input: [{ type: 'user.message', content: opts.prompt }],
  });

  let text = '';

  // Tool calls arrive on model.message.delta as chunked deltas, not on a final
  // model.message: the id + meta fn (e.g. call_tool) land on the first fragment,
  // and the JSON arguments (which carry the real mcp_server + tool_name for the
  // deferred tool-loading meta-tools) trickle in as a long chain of tiny
  // fragments. Accumulate each call's id + arguments as they stream, resolve
  // the label once the JSON is whole, and hang every subsequent tool.response
  // off its id. Otherwise every line reads the same anonymous " returned N B"
  // and the 429s tell you nothing.
  const pending: { id: string; fn: string; args: string; label?: string; announced?: boolean }[] = [];
  const byIndex = new Map<number, { id: string; fn: string; args: string; label?: string; announced?: boolean }>();

  const announce = (call: { id: string; fn: string; args: string; label?: string; announced?: boolean }) => {
    if (call.announced) return;
    call.announced = true;
    const label = describeToolCall(call.fn, call.args);
    call.label = label;
    opts.emit('tool', `calling ${label}`);
  };

  for await (const { data: event } of stream.withMetadata()) {
    if (event.type === 'model.message.delta' && event.content) text += event.content;

    if (event.type === 'model.message.delta' && event.toolCalls?.length) {
      // Continuation fragments repeat the index but drop the id; the id-bearing
      // fragment starts (or reopens) the call for that index.
      for (const frag of event.toolCalls) {
        let call = byIndex.get(frag.index);
        if (!call || frag.id) {
          call = { id: frag.id ?? '', fn: frag.function?.name ?? '', args: frag.function?.arguments ?? '' };
          byIndex.set(frag.index, call);
          pending.push(call);
        } else {
          call.args += frag.function?.arguments ?? '';
        }
        if (frag.function?.name) call.fn = frag.function.name;
        if (call.args) {
          try {
            const parsed = JSON.parse(call.args);
            if (parsed && typeof parsed === 'object' && (parsed.mcp_server || parsed.tool_name)) announce(call);
          } catch {
            // arguments still partial — wait for the next fragment
          }
        }
      }
    }

    if (event.type === 'tool.response') {
      // Prefer the exact id; fall back to the most recently described tool in
      // the case where the meta-tool's response id doesn't line up.
      const call = pending.find((p) => p.id === event.toolCallId);
      if (call) announce(call);
      const name = call?.label ?? pending.filter((p) => p.label).at(-1)?.label ?? 'tool';
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

/** Deferred tool loading routes every real call through meta tools
 *  (list_tools / get_tool_info / call_tool) whose own name says nothing — the
 *  actual target lives in their arguments. Unwrap it so logs read
 *  "reddit.search_reddit" instead of "call_tool". */
function describeToolCall(metaName: string, argsJson: string): string {
  if (!['call_tool', 'list_tools', 'get_tool_info', 'get_tool_output_schema'].includes(metaName)) return metaName;
  try {
    const args = JSON.parse(argsJson) as { mcp_server?: string; tool_name?: string };
    if (!args.mcp_server) return metaName;
    if (metaName === 'call_tool' && args.tool_name) return `${args.mcp_server}.${args.tool_name}`;
    if (metaName === 'list_tools') return `${args.mcp_server} (discovering tools)`;
    return args.tool_name ? `${args.mcp_server}.${args.tool_name} (schema)` : metaName;
  } catch {
    return metaName;
  }
}

/** Turn an MCP error blob into one readable clause. Kept defensive: the blob can
 *  be a clean error JSON, a nested {"error":{...}} envelope, or an unparsable
 *  pile of bytes — never emit the raw, truncated JSON back into the log. */
function summarizeFailure(content: string): string {
  const live = content.slice(0, 2000);
  // Some backends return a bare "429 Too Many Requests" status line ahead of
  // (or instead of) a JSON body, which the "code"/"status" field match below
  // never sees — catch that shape first so a rate limit reads as one, not as
  // a slice of raw, truncated JSON.
  if (/\b429\b.*too many requests/i.test(live) || /rate.?limit/i.test(live)) return 'rate limited (429)';
  const code = live.match(/"(?:code|status)"\s*:\s*(\d{3})/)?.[1];
  if (code === '429') return 'rate limited (429)';
  if (code) return `HTTP ${code}`;
  const message = live.match(/"(?:message|text|error)"\s*:\s*"([^"]{0,160})/)?.[1];
  if (message) return message.replace(/\\n/g, ' ').replace(/\\"/g, '"').trim();
  // Straight error prose ("list index out of range") with no JSON envelope:
  const plain = live.replace(/\s+/g, ' ').replace(/^["'{}\[\],:]+/, '').trim().slice(0, 160);
  if (plain) return plain;
  return 'no detail returned';
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

export const FOOTPRINT_INSTRUCTIONS = `You map a company's entire public footprint — not just the accounts on their own site. Run the search connectors attached to you and hunt venue by venue for any channel where this company has a presence, official OR unofficial:

- Subreddits (r/<name>), Hacker News profile, Discord servers
- Messaging groups: Telegram (t.me/<name>), Signal group links, WhatsApp group/channel links
- Review platforms: Trustpilot, Google reviews, Yelp — even when the company does not run them
- Socials: Facebook, Instagram, TikTok, Snapchat, X, YouTube, LinkedIn, GitHub — official account plus any fan/community/impostor one
- Community forums and blogs

For each channel report platform, a short handle/title, the url, and whether it is OFFICIAL (run by the company itself) or UNOFFICIAL (fan, community, review, impersonation, third-party). The profile URL is a real, openable link. Do not invent a url — if you could not find one, skip it. Collect every real channel you find, even an unflattering or unofficial one; a company with no unofficial footprint is a finding too. Include at least the clearly-offical accounts the site links to if your search turned them up. When tools are not attached or one venue fails, note it and search the rest.

One row per real account: use x.com not twitter.com, the canonical YouTube URL (youtube.com/@handle) not a /c/ or /channel/ variant, and the handle exactly as the platform shows it with no extra @ prefix. If a search turns up the same account under two URLs, report it once.`;

/** Map a company's footprint. The site scrape yields the accounts the company
 *  itself links to (tagged official); a search sweep then adds the unofficial
 *  and third-party channels — subreddits, messaging groups, review platforms,
 *  socials — so the panel shows everything out there, not just the site. */
/** Same-account URLs the model returns inconsistently, collapsed to one key so
 *  they dedupe instead of showing up as separate rows: aliased hosts
 *  (twitter.com/x.com), and per-platform path variants (YouTube's /c/,
 *  /channel/, /@ and bare-name forms) that all point at one channel. */
function canonicalProfileKey(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl.trim().toLowerCase();
  }

  let host = url.hostname.toLowerCase().replace(/^www\./, '');
  const HOST_ALIASES: Record<string, string> = { 'twitter.com': 'x.com' };
  host = HOST_ALIASES[host] ?? host;

  let path = url.pathname.replace(/\/+$/, '').toLowerCase();
  if (host.endsWith('youtube.com')) {
    path = path.replace(/^\/(c|channel|user)\//, '/').replace(/^\/@/, '/');
  } else {
    path = path.replace(/^\/@/, '/');
  }

  return `${host}${path}`;
}

export async function findPresence(
  company: string, site: string, emit: Emit,
): Promise<Profile[]> {
  // Two deterministic sources, no agent loop and no model:
  //
  //  1. the company's own site — render it and classify its outbound links
  //     (skills/extract-social-media). Authoritative when it works, but it is
  //     one HTTP fetch away from being useless: plenty of marketing sites sit
  //     behind a bot check that serves a challenge page instead of the footer.
  //  2. plain web search for the accounts themselves. This is what a person
  //     would do, it costs a few seconds, and it still works when (1) is
  //     blocked.
  //
  // (2) is not a fallback for (1) — they are merged, because the site footer
  // misses community accounts (a subreddit, a Discord) that search finds, and
  // search misses accounts that are only ever linked from the site.
  const merged = new Map<string, Profile>();

  try {
    const { stdout: html } = await run('bash', [path.join(SKILL, 'scrape.sh'), site], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
      encoding: 'utf8',
    });

    // A bot check returns HTTP 200 with a challenge page in the body, so a
    // "successful" scrape can still carry no site content at all. Say so —
    // silently returning zero accounts reads as "this company has none".
    if (/Just a moment|Performing security verification|Checking your browser|cf-browser-verification/i.test(html)) {
      emit('warn', `${site} is behind a bot check — reading its accounts from search instead`);
    } else {
      const stdout = await pipeThrough('python3', [path.join(SKILL, 'extract_social.py'), '--base', site], html);
      const parsed = JSON.parse(stdout) as { profiles: Profile[] };
      for (const profile of parsed.profiles ?? []) {
        if (!profile?.url) continue;
        merged.set(canonicalProfileKey(profile.url), { ...profile, official: true });
      }
      emit('info', `${merged.size} accounts linked from ${company}'s own site`);
    }
  } catch (error) {
    emit('warn', `site scrape failed: ${error instanceof Error ? error.message : 'error'} — falling back to search`);
  }

  const fromSite = merged.size;

  // The company's own name plus each platform. Cheap, and it is exactly the
  // query a person types.
  const queries = [
    `${company} official x.com twitter`,
    `${company} linkedin company page`,
    `${company} github`,
    `${company} youtube channel`,
    `${company} discord community invite`,
    `${company} subreddit reddit`,
    `${company} instagram tiktok`,
  ];

  const hits = await braveSearchAll(queries, 10, (query, message) =>
    emit('warn', `search "${query}" failed — ${message}`));

  for (const hit of hits) {
    const platform = platformOf(hit.url);
    if (!platform) continue;
    // Reject posts, statuses, hashtags and topic pages — only account homes.
    const handle = profileHandle(hit.url);
    if (!handle) continue;

    const key = canonicalProfileKey(hit.url);
    if (merged.has(key)) continue;

    // "Official" means the account looks like it belongs to the company: its
    // handle contains the company name. Anything else is a real channel about
    // the company but not run by it, and the dashboard splits on exactly that.
    const slug = company.toLowerCase().replace(/[^a-z0-9]/g, '');
    const normalized = handle.toLowerCase().replace(/[^a-z0-9]/g, '');
    const official = Boolean(slug) && normalized.includes(slug);

    merged.set(key, {
      platform,
      handle,
      url: hit.url,
      official,
      confidence: official ? 'high' : 'low',
    });
  }

  const profiles = [...merged.values()].sort((a, b) =>
    a.platform.localeCompare(b.platform) || a.handle.localeCompare(b.handle));

  emit('info', `${profiles.length} accounts (${fromSite} from the site, ${profiles.length - fromSite} from search)`);
  return profiles;
}

/** Turn "Lovable" into a URL. A domain-shaped input is taken at its word.
 *
 *  This used to be an agent turn. It is one web search: the first result that
 *  sits on a plausible company domain wins. That is both faster and steadier
 *  than asking a model to recall a URL, and it cannot hallucinate a domain that
 *  does not exist. */
export async function resolveSite(company: string, emit: Emit): Promise<string> {
  const trimmed = company.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[\w-]+(\.[\w-]+)+$/.test(trimmed)) return `https://${trimmed}`;

  // Directories, app stores and social profiles all rank for a company name;
  // none of them is the company's own site.
  const NOT_THEIRS =
    /(wikipedia|crunchbase|linkedin|twitter|x\.com|facebook|instagram|youtube|github|reddit|medium|substack|producthunt|g2\.com|capterra|trustpilot|glassdoor|apps\.apple|play\.google|sourceforge|stackshare)\./i;

  const hits = await braveSearch(`${trimmed} official website`, 10);
  const slug = trimmed.toLowerCase().replace(/[^a-z0-9]/g, '');

  const candidates = hits.filter((hit) => !NOT_THEIRS.test(hit.url));
  // Strongly prefer a domain that actually contains the company name.
  const owned = candidates.find((hit) => {
    try {
      return new URL(hit.url).hostname.toLowerCase().replace(/[^a-z0-9]/g, '').includes(slug);
    } catch {
      return false;
    }
  });

  const chosen = owned ?? candidates[0] ?? hits[0];
  if (!chosen) throw new Error(`no search result for "${trimmed}" — cannot resolve a site`);

  const origin = new URL(chosen.url).origin;
  emit('info', `resolved "${trimmed}" to ${origin}`);
  return origin;
}

/* --------------------------------------------------------------- discovery */

export const DISCOVERY_INSTRUCTIONS = `You find where people discuss software by actually running the search connectors attached to you. Do the searching yourself with the real tools — do not answer from memory, and do not return "nothing" without first running every connector that is attached.

Check which tools are attached, then search venue by venue:

1. Reddit and Hacker News: you have no dedicated tool for either — search them through Bright Data's search_engine and scrape_as_markdown with site-scoped queries ("site:reddit.com <alias>", "site:news.ycombinator.com <alias>"), then scrape_as_markdown the threads that come up to read the actual comments. A thread with real comments is the goal, but a search hit with a real post you can see is still reportable.
2. X: if an X search/fetch tool is attached, run it for the alias and pull the actual post text. If not attached, say so and search "site:x.com" via web search instead.
3. Wider web: run search_engine (Bright Data) or Brave for several narrow queries — plain mention, "X vs", "X review", "X problems", "we use X", "switched from X" — and scrape_as_markdown the promising results to read what was actually said.
4. Messaging groups (Telegram, Signal, WhatsApp) are real venues — hunt for the company's channels/groups/invite links (t.me, signal.me/signal.group, chat.whatsapp.com/wa.me/whatsapp.com/channel) via web search and the company's own pages. Report official and unofficial communities both, tagged by venue. If you cannot open a group, a short factual note that it exists (name, size if shown) is a valid finding.

Report what the connectors actually gave you. The empty scan is the worst outcome — an honest "no Reddit presence, 2 HN mentions" is a real result; silently returning an empty list when you found search hits is a failure. Collect every real URL you found, even if you could not open the page or read the comments.

The excerpt is a verbatim quote of what a real person wrote when you could read it; when you could not open the source, put a short factual description of what the link is instead. Never invent a quote, a URL, a date, or an engagement count.

Rules:
- Run the searches. Tool failures and rate limits are not the end — note them, move to the next venue, and report what the others gave you.
- Never invent a URL, a date, an engagement count, or a quote.
- Skip press releases, listicles, job postings and the company's own docs and blog (a vendor post syndicated to five sites is one voice).
- Prefer dated, reachable discussion, but include relevant recent findings even without a date you could verify.
- Return up to 40 mentions, newest first. Venue coverage beats a lopsided pile: try to include each venue where you found something.`;

export async function findMentions(
  company: string, site: string, profiles: Profile[], servers: string[], emit: Emit,
): Promise<Mention[]> {
  // Venue by venue, as site-scoped queries. No agent decides which of these to
  // run or in what order — they all run, every time, and a failure in one is a
  // logged warning rather than a dead stage.
  // Two halves, deliberately.
  //
  // The general half finds who is talking about the product at all. The
  // complaint half goes looking for the words people actually use when
  // something is wrong — "broken", "not working", "slow". Without it the corpus
  // fills with reviews and "best alternatives" roundups, nobody in it is
  // complaining, and the health stage has nothing to triage while sentiment is
  // scored over SEO copy rather than over anyone's experience.
  const queries = [
    `site:reddit.com ${company}`,
    `site:news.ycombinator.com ${company}`,
    `site:x.com ${company}`,
    `site:github.com ${company} issue`,
    `"${company}" review`,
    `"${company}" vs`,
    `"we use ${company}"`,
    `"switched from ${company}"`,

    // Complaint language.
    `"${company}" broken`,
    `"${company}" "not working"`,
    `"${company}" slow OR laggy OR timeout`,
    `"${company}" bug OR crash OR error`,
    `"${company}" "doesn't work"`,
    `"${company}" frustrating OR unusable`,
    `"${company}" billing OR charged OR refund problem`,
    `site:reddit.com "${company}" problem OR broken OR bug`,
    `site:news.ycombinator.com "${company}" broken OR bug OR slow`,
  ];

  // A subreddit or GitHub org we already found is a sharper query than a blind
  // name search, so fold the real ones in.
  for (const profile of profiles.filter((candidate) => candidate.official)) {
    if (profile.platform === 'reddit' && profile.handle.startsWith('r/')) {
      queries.push(`site:reddit.com/${profile.handle} ${company}`);
    }
    if (profile.platform === 'github') queries.push(`site:github.com/${profile.handle} issues`);
  }

  emit('info', `running ${queries.length} searches`);
  const hits = await braveSearchAll(queries, 10, (query, message) =>
    emit('warn', `search "${query}" failed — ${message}`));
  emit('info', `${hits.length} distinct results`);

  const ownHost = (() => {
    try {
      return new URL(site).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  })();

  const usable = hits
    // A vendor's own blog, docs and status page are not third-party discussion.
    .filter((hit) => !ownHost || !hit.url.includes(ownHost))
    // A brand that is also an ordinary word drags in dictionary and spelling
    // pages, which carry no opinion to score and no complaint to triage.
    .filter((hit) => !isLexicalNoise(hit));

  const dropped = hits.length - usable.length;
  if (dropped) emit('info', `dropped ${dropped} dictionary/spelling result(s)`);

  // Real discussion ahead of SEO roundups, so the 60 we keep are the 60 worth
  // reading rather than whatever the merge order happened to be.
  const ordered = [
    ...usable.filter((hit) => isOpinionBearing(hit)),
    ...usable.filter((hit) => !isOpinionBearing(hit)),
  ];
  emit('info', `${ordered.filter(isOpinionBearing).length} of ${ordered.length} look like real discussion`);

  return ordered
    .map((hit) => ({
      id: randomUUID().slice(0, 8),
      venue: venueOf(hit.url),
      title: hit.title,
      url: hit.url,
      date: hit.date,
      author: null,
      excerpt: hit.description,
      engagement: null,
      // Sentiment is the model's job, in the buzz stage, over this fetched
      // text. Search does not guess at it.
      sentiment: 'neutral' as const,
      score: 0,
      themes: [],
    }))
    .slice(0, 60);
}

/* ------------------------------------------------------------------- feed */

export const FEED_INSTRUCTIONS = `You are a brand's live feed listener. Run the search connectors attached to you and pull the LATEST things that have surfaced about the company — this is a feed, not a survey, so the most recent wins.
Do the searching yourself with the real tools; do not answer from memory.
Venue by venue:
- YouTube first (search_youtube / video search): new videos about the product. For each video, also open its comments and report the notable recent ones verbatim.
- Reddit and Hacker News: no dedicated tool for either — use Bright Data's search_engine with "site:reddit.com" / "site:news.ycombinator.com" queries, then scrape_as_markdown the threads that come up to read the newest comments verbatim, not a paraphrase.
- Web search (Bright Data, Brave), X, Telegram, and any other attached connector: whatever fresh posts, comments or reviews turned up.
Classify each item as a video (an upload), a comment (text inside a thread or under a video), or a post (the thread or post itself).
For every item report: the venue (the source it came from), the kind (video/comment/post), the headline (video title or post title), the URL that links straight to it, the date it appeared, the author/channel, the snippet (the comment text verbatim when it is a comment, otherwise what the post/video says), and the engagement count.
Only report things you actually retrieved from a connector result — no invented posts, no recollections. If nothing recent exists, return an empty list rather than making things up. Order newest first, and if two items are the same minute, keep the comment after its thread or video.`;

/** Pull the latest things to surface about a company — new videos, comments and
 *  posts, newest first — by running the attached search connectors (YouTube
 *  search first). */
export async function findFeed(
  company: string, site: string, profiles: Profile[], servers: string[], emit: Emit,
): Promise<FeedItem[]> {
  // The feed is the same deterministic search, biased to fresh things and
  // sorted newest first. YouTube gets its own queries because video is the
  // feed's primary source.
  const queries = [
    `${company} news`,
    `${company} latest`,
    `site:youtube.com ${company}`,
    `site:reddit.com ${company}`,
    `site:news.ycombinator.com ${company}`,
    `"${company}" update release`,
  ];

  for (const profile of profiles.filter((candidate) => candidate.official)) {
    if (profile.platform === 'youtube') queries.push(`site:youtube.com ${profile.handle} ${company}`);
    if (profile.platform === 'reddit' && profile.handle.startsWith('r/')) {
      queries.push(`site:reddit.com/${profile.handle}`);
    }
  }

  emit('info', `feed: running ${queries.length} searches`);
  const hits = await braveSearchAll(queries, 10, (query, message) =>
    emit('warn', `search "${query}" failed — ${message}`));

  const kindOf = (url: string): FeedItem['kind'] => {
    if (/youtube\.com\/watch|youtu\.be\//.test(url)) return 'video';
    if (/\/comments\/.+\/.+\/.+/.test(url)) return 'comment';
    return 'post';
  };

  const items = hits.map((hit) => ({
    id: randomUUID().slice(0, 8),
    venue: venueOf(hit.url),
    kind: kindOf(hit.url),
    headline: hit.title,
    url: hit.url,
    date: hit.date,
    author: null,
    snippet: hit.description,
    engagement: null,
  })) as FeedItem[];

  emit('info', `feed: ${items.length} items, ${items.filter((item) => item.date).length} dated`);

  // Dated items first, newest to oldest; undated ones keep search order behind
  // them rather than being dropped.
  return items
    .sort((a, b) => {
      if (a.date && b.date) return b.date.localeCompare(a.date);
      if (a.date) return -1;
      if (b.date) return 1;
      return 0;
    })
    .slice(0, 60);
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

export const BUZZ_INSTRUCTIONS = `You read public discussion and rate how people feel about a product.

Score each item from -1 (hostile) to +1 (delighted). 0 is genuinely neutral — a factual mention with no opinion — not a hedge for "unsure". Rate the commenters' view of the product, not the writing quality, and not the sentiment of the topic.

A frustrated user reporting a bug they want fixed is negative but engaged; mark it negative and tag the theme. Sarcasm reads as its opposite; judge intent.

Themes are two or three words, reusable across items ("cold starts", "pricing", "docs gaps"), not sentence fragments.

The verdict names the direction perception is moving and what is driving it, in one paragraph, citing what you saw rather than generalities.`;

export async function scoreBuzz(
  company: string, mentions: Mention[], emit: Emit,
): Promise<{ mentions: Mention[]; verdict: string }> {
  if (mentions.length === 0) return { mentions, verdict: 'No third-party discussion found to score.' };

  // Score in batches rather than in one turn.
  //
  // A single turn over 60 mentions has to emit 60 scored objects before it
  // returns anything, which on a local model means thousands of output tokens
  // against a 4k cap and several minutes of silence — and if it trips at token
  // 3,900 the whole stage is lost. Batches keep each turn inside the model's
  // context and output limits, let a bad batch fail on its own without taking
  // the other five with it, and report progress as they land.
  // 4, and note this shrank twice for the same reason.
  //
  // 12 breached the model's 4,096-token output cap. 8 held while the corpus was
  // search snippets, then started timing out and truncating mid-JSON once real
  // page text was fetched: more input to read means more reasoning emitted
  // before the answer starts, and the answer has to fit in what is left. 4
  // items of real discussion is what actually completes here.
  const BATCH = 4;

  /** Characters of page text per item. Real thread text is far longer than a
   *  search snippet and has to be trimmed to leave output budget. */
  const TEXT_BUDGET = 900;
  const batches: Mention[][] = [];
  for (let i = 0; i < mentions.length; i += BATCH) batches.push(mentions.slice(i, i + BATCH));

  // Fetch what people actually wrote before scoring any of it. Without this the
  // model is rating Brave's meta description — SEO copy, not opinion.
  emit('info', `fetching real page text for ${mentions.length} mentions`);
  const fetched = await fetchAll(mentions, (done, total, full) =>
    emit('info', `fetched ${done}/${total} (${full} with full text)`));
  const fullCount = [...fetched.values()].filter((f) => f.full).length;
  emit('info', `${fullCount}/${mentions.length} yielded real content; the rest keep their search snippet`);

  emit('info', `scoring ${mentions.length} mentions in ${batches.length} batches of ${BATCH}`);

  const scores = new Map<string, { sentiment: Mention['sentiment']; score: number; themes?: string[] }>();
  const verdicts: string[] = [];

  for (const [index, batch] of batches.entries()) {
    const corpus = batch.map((m) => {
      const got = fetched.get(m.url);
      return {
        url: m.url,
        venue: m.venue,
        date: m.date,
        title: m.title,
        // Real thread text where it could be fetched, the snippet otherwise —
        // flagged, so the model knows when it is judging a summary rather than
        // someone's actual words.
        text: (got?.text ?? m.excerpt).slice(0, TEXT_BUDGET),
        isFullText: got?.full ?? false,
      };
    });

    try {
      // Straight to the model endpoint with the schema attached — see
      // app/server/model.ts for why this does not go through a saved agent.
      const { scored, verdict } = await askJsonDirect<{
        scored: { url: string; sentiment: Mention['sentiment']; score: number; themes?: string[] }[];
        verdict: string;
      }>({
        instructions: BUZZ_INSTRUCTIONS,
        prompt: `Product: "${company}". Score every item and write the verdict.\n\n${JSON.stringify(corpus)}`,
        schema: buzzSchema,
      });

      // A model that ignores the -1..1 range (local ones return 0-10 often
      // enough) would otherwise clamp to +1 and read as unanimous delight.
      // Flag it rather than quietly recording the wrong sentiment.
      const outOfRange = (scored ?? []).filter((entry) => Math.abs(Number(entry?.score) || 0) > 1).length;
      if (outOfRange) {
        emit('warn', `batch ${index + 1}: ${outOfRange} score(s) outside -1..1 — clamped, treat this batch's numbers as rough`);
      }

      for (const entry of scored ?? []) if (entry?.url) scores.set(entry.url, entry);
      if (verdict) verdicts.push(verdict);
      emit('info', `batch ${index + 1}/${batches.length}: ${(scored ?? []).length} scored`);
    } catch (error) {
      // One failed batch leaves those mentions unscored (neutral); it does not
      // cost the batches that worked.
      emit('warn', `batch ${index + 1}/${batches.length} failed — ${error instanceof Error ? error.message.slice(0, 120) : 'error'}`);
    }
  }

  if (scores.size === 0) throw new Error('every buzz batch failed — nothing could be scored');

  emit('info', `${scores.size}/${mentions.length} mentions scored`);

  const scored = mentions.map((m) => {
    const hit = scores.get(m.url);
    if (!hit) return m;
    return {
      ...m,
      sentiment: hit.sentiment ?? 'neutral',
      score: clamp(hit.score ?? 0),
      themes: hit.themes ?? [],
    };
  });

  // One verdict written over the whole corpus, not fifteen batch verdicts glued
  // end to end.
  //
  // Concatenating them produced a paragraph that argued with itself — "drifting
  // negative, and the pull is growing steeper" immediately followed by
  // "flat-to-slightly-positive" — because each batch only ever saw four items
  // and generalised from them. A verdict is a claim about the whole window, so
  // it has to be written somewhere that can see the whole window. This call is
  // cheap: it reasons over the tallies and a sample, not the full corpus.
  const verdict = await summariseVerdict(company, scored, emit)
    // Falling back to the first batch verdict is worse than the real thing but
    // better than nothing, and much better than the contradictory join.
    .catch(() => verdicts[0] ?? '');

  return { mentions: scored, verdict };
}

/** Write the one-paragraph verdict over the finished corpus. */
async function summariseVerdict(company: string, mentions: Mention[], emit: Emit): Promise<string> {
  const tally = { positive: 0, negative: 0, neutral: 0, mixed: 0 } as Record<string, number>;
  const themes = new Map<string, number>();
  for (const m of mentions) {
    tally[m.sentiment] = (tally[m.sentiment] ?? 0) + 1;
    for (const theme of m.themes ?? []) themes.set(theme, (themes.get(theme) ?? 0) + 1);
  }

  // The extremes carry the argument; the middle rarely says anything sharp.
  const ranked = [...mentions].sort((a, b) => a.score - b.score);
  const sample = [...ranked.slice(0, 8), ...ranked.slice(-8)].map((m) => ({
    date: m.date, score: m.score, title: m.title, excerpt: m.excerpt.slice(0, 200),
  }));

  const top = [...themes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

  emit('info', 'writing the verdict over the whole window');
  const { verdict } = await askJsonDirect<{ verdict: string }>({
    instructions: BUZZ_INSTRUCTIONS,
    prompt: `Product: "${company}". Write ONLY the one-paragraph verdict for the whole window — `
      + `which way perception is moving and what is driving it. Do not score anything.\n\n`
      + `Totals across ${mentions.length} mentions: ${JSON.stringify(tally)}\n`
      + `Most common themes: ${JSON.stringify(top)}\n\n`
      + `The most negative and most positive items:\n${JSON.stringify(sample)}`,
    schema: verdictSchema,
  });
  return verdict ?? '';
}

const clamp = (n: number) => Math.max(-1, Math.min(1, Number(n) || 0));

/* ------------------------------------------------------------------ health */

export const HEALTH_INSTRUCTIONS = `You triage public complaints into engineering issues.

Keep only problems in the product: bugs, broken or confusing interfaces, slowness, unreliability, missing documentation, billing surprises, and gaps people hit repeatedly. Discard opinion, pricing objections that are not billing bugs, competitor preference, and anything that is a support question rather than a defect.

Merge duplicates: one issue per underlying cause, with every supporting URL in evidence. An issue raised by four people is one issue.

Severity: critical = data loss, outage, or a security exposure; serious = a broken workflow with no workaround; warning = friction with a workaround; good = a resolved or minor nit.

The draft reply is written to the people who raised it. Acknowledge the specific thing that happened, say plainly what is being done about it, and stop. No apology theatre, no gratitude padding, no promised dates, no marketing.`;

export async function findIssues(
  company: string, mentions: Mention[], emit: Emit,
): Promise<Issue[]> {
  // Worst-first, and capped: triage has to emit a full issue object (summary,
  // impact, evidence, a draft reply) per issue, which is far more output per
  // input than scoring is. Handing it every complaint at once overruns the
  // model's output cap and loses the entire stage, so take the most negative
  // ones — those are the issues worth filing anyway.
  const MAX_COMPLAINTS = 20;
  const complaints = mentions
    .filter((m) => m.score < 0.15)
    .sort((a, b) => a.score - b.score)
    .slice(0, MAX_COMPLAINTS);
  if (complaints.length === 0) return [];

  // Same treatment as scoring: triage the real complaint text, not a snippet.
  // These pages are almost all already in the content cache from the buzz
  // stage, so this is close to free.
  emit('info', `fetching complaint text for ${complaints.length} mentions`);
  const fetched = await fetchAll(complaints, (done, total, full) =>
    emit('info', `fetched ${done}/${total} (${full} with full text)`));

  const corpus = complaints.map((m) => {
    const got = fetched.get(m.url);
    return {
      url: m.url,
      date: m.date,
      venue: m.venue,
      title: m.title,
      text: (got?.text ?? m.excerpt).slice(0, 900),
      isFullText: got?.full ?? false,
    };
  });

  // Batched, for the same reason buzz is: one issue object carries a summary,
  // an impact statement, an evidence list and a draft reply, so a triage turn
  // over twenty complaints has to emit far more text than a scoring turn does.
  // Unbatched it ran past the request timeout and the whole stage was lost.
  //
  // The cost is real and worth stating: merging duplicates ("one issue per
  // underlying cause") can only happen inside a batch, so the same complaint
  // raised in two different batches can surface twice.
  const BATCH = 3;
  const batches: typeof corpus[] = [];
  for (let i = 0; i < corpus.length; i += BATCH) batches.push(corpus.slice(i, i + BATCH));

  emit('info', `triaging ${complaints.length} complaints in ${batches.length} batches`);

  const issues: Omit<Issue, 'id' | 'status' | 'firstSeen' | 'lastSeen'>[] = [];
  for (const [index, batch] of batches.entries()) {
    try {
      const result = await askJsonDirect<{ issues: Omit<Issue, 'id' | 'status' | 'firstSeen' | 'lastSeen'>[] }>({
        instructions: HEALTH_INSTRUCTIONS,
        prompt: `Product: "${company}". Triage these complaints.\n\n${JSON.stringify(batch)}`,
        schema: healthSchema,
      });
      issues.push(...(result.issues ?? []));
      emit('info', `batch ${index + 1}/${batches.length}: ${(result.issues ?? []).length} issue(s)`);
    } catch (error) {
      emit('warn', `batch ${index + 1}/${batches.length} failed — ${error instanceof Error ? error.message.slice(0, 120) : 'error'}`);
    }
  }

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

export const ABUSE_INSTRUCTIONS = `You look for people abusing a brand's name, and you report only what the evidence supports.

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
  // Same split as the rest of the pipeline: deterministic code goes and finds
  // the candidate pages, then the model is asked once to judge which of them
  // are actually brand abuse. Handing an agent a search tool and asking it to
  // hunt could not produce valid JSON here, and the hunting part is a fixed set
  // of queries anyway — these are the surfaces abuse shows up on.
  const queries = [
    `"${company}" scam`,
    `"${company}" phishing`,
    `"${company}" fake support`,
    `"${company}" giveaway airdrop`,
    `"${company}" impersonating OR impersonation`,
    `"${company}" crack OR nulled OR cracked`,
    `site:npmjs.com ${company}`,
    `site:t.me ${company}`,
  ];

  emit('info', `integrity sweep: ${queries.length} searches`);
  const hits = await braveSearchAll(queries, 8, (query, message) =>
    emit('warn', `search "${query}" failed — ${message}`));

  const ownHost = (() => {
    try {
      return new URL(site).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  })();

  // The company's own pages are not abusing the company.
  const candidates = hits
    .filter((hit) => !ownHost || !hit.url.includes(ownHost))
    .slice(0, 30)
    .map((hit) => ({ url: hit.url, title: hit.title, excerpt: hit.description.slice(0, 300) }));

  if (candidates.length === 0) {
    emit('info', 'integrity sweep found nothing to judge');
    return [];
  }
  emit('info', `judging ${candidates.length} candidate pages`);

  // Batched, like buzz and health. Judging thirty candidate pages in one turn
  // is the shape that kept timing out and losing the whole stage; ten at a time
  // completes, and a batch that fails costs only its own ten.
  const BATCH = 10;
  const batches: typeof candidates[] = [];
  for (let i = 0; i < candidates.length; i += BATCH) batches.push(candidates.slice(i, i + BATCH));

  const findings: Omit<AbuseFinding, 'id' | 'status' | 'firstSeen'>[] = [];
  for (const [index, batch] of batches.entries()) {
    try {
      const result = await askJsonDirect<{ findings: Omit<AbuseFinding, 'id' | 'status' | 'firstSeen'>[] }>({
        instructions: ABUSE_INSTRUCTIONS,
        prompt: `Company: "${company}" (${site}).

These pages came back from searches for misuse of this brand — impersonating accounts and Discord/Telegram servers, lookalike domains, phishing pages, giveaway and airdrop scams, fake support, counterfeit or cracked distributions, and packages published under the name.

Most of them will be ordinary coverage, reviews or discussion that merely uses the words — report only the ones the evidence actually supports as abuse, and return an empty list if none do.

Candidates:
${JSON.stringify(batch)}`,
        schema: abuseSchema,
      });
      findings.push(...(result.findings ?? []));
      emit('info', `batch ${index + 1}/${batches.length}: ${(result.findings ?? []).length} finding(s)`);
    } catch (error) {
      emit('warn', `batch ${index + 1}/${batches.length} failed — ${error instanceof Error ? error.message.slice(0, 120) : 'error'}`);
    }
  }

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
