/** Deterministic web search — plain HTTP, no agent, no model.
 *
 *  The pipeline used to route "search Reddit and Hacker News for mentions"
 *  through an LLM tool-calling loop. That cost minutes per stage and had
 *  several independent ways to fail (provider rate limits, deferred-tool round
 *  trips, and the model emitting a malformed tool call or invalid JSON), and it
 *  regularly returned nothing at all. Underneath, it is a handful of HTTP
 *  requests. This module is those requests.
 *
 *  The model's job starts *after* this: classification, sentiment and triage
 *  over text that has already been fetched.
 */

import { cleanText } from '../shared/html.ts';
import { cached, DAY, HOUR } from './cache.ts';
import { usableConnectors } from './config.ts';
import { unwrapUntrusted } from './content.ts';
import { bindingFor } from './roles.ts';
import { chainFor, connectorsForRole } from './providers.ts';
import { abortable, isDeep, throwIfCancelled } from './run-context.ts';
import { anyComplaintWord } from './languages.ts';
import { noteSpend, outOfCredit, resetRunSpend, spentItsTurn } from './credits.ts';
import { callTool } from './mcp.ts';
import { secret } from './secrets.ts';
import type { Venue } from '../shared/types.ts';

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

export interface SearchHit {
  title: string;
  url: string;
  description: string;
  /** Brave's own freshness string ("3 days ago", "March 14, 2024") when present. */
  age: string | null;
  /** ISO date when Brave exposed a parseable one, else null. */
  date: string | null;
}

/** Brave's free tier enforces one request per second and 429s anything faster.
 *  Every call in this process funnels through one promise chain so concurrent
 *  callers queue instead of bursting — the burst is what was 429ing most of a
 *  run before. */
let gate: Promise<unknown> = Promise.resolve();
const MIN_INTERVAL_MS = 1_100;

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = gate.then(fn, fn);
  gate = next.then(
    () => new Promise((r) => setTimeout(r, MIN_INTERVAL_MS)),
    () => new Promise((r) => setTimeout(r, MIN_INTERVAL_MS)),
  );
  return next;
}

/** Brave reports dates as prose ("2 weeks ago") or as a date string. Keep only
 *  what parses; a wrong date is worse than no date. */
function parseAge(age: string | undefined, pageAge: string | undefined): string | null {
  // A date in the future is a CMS template or a timezone artefact, not news,
  // and it sorts above everything real in a newest-first feed. A day of slack
  // covers timezones without letting "published next March" through.
  const horizon = Date.now() + 86_400_000;
  const take = (value: number) => (value <= horizon ? new Date(value).toISOString() : null);

  const iso = pageAge && Date.parse(pageAge);
  if (iso && !Number.isNaN(iso)) return take(iso);
  if (age) {
    const direct = Date.parse(age);
    if (!Number.isNaN(direct)) return take(direct);
  }
  return null;
}

/** Does this result actually name the company anywhere?
 *
 *  The single most effective relevance filter available here, and it became
 *  necessary the moment the search started asking for the freshest possible
 *  results. Every news site's front page is recrawled continuously, so it is
 *  permanently "from the last hour" — searching a tight window for "<company>
 *  news" returns CNN, Reuters and Google News ahead of anything about the
 *  company, because those pages are fresh by construction and match the word
 *  "news". Requiring the name to appear removes all of them for the cost of one
 *  string comparison.
 */
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function namesCompany(hit: SearchHit, company: string): boolean {
  const needle = company.toLowerCase().trim();
  if (!needle) return true;

  const text = `${hit.title} ${hit.description}`.toLowerCase();
  const url = hit.url.toLowerCase();

  // Whole word, not substring.
  //
  // Substring matching is why a scan for "Bolt" came back with "Boltt Evo,
  // Boltt Ace 5G Software Update Policy" — a different company whose name
  // merely starts the same way. It would equally admit Usain Bolt, the Chevy
  // Bolt EV, "bolted", and every lightning bolt on the internet. Short brand
  // names are common English words often enough that this is the normal case,
  // not an edge one.
  //
  // A boundary here is a non-letter, deliberately rather than \b: \b treats a
  // digit as a word character, so "bolt" would still match "bolt3d", and it
  // treats an apostrophe as a boundary, which is what makes "GIMP's" match.
  const boundary = new RegExp(`(^|[^a-z])${escapeRe(needle)}([^a-z]|$)`, 'i');
  if (boundary.test(text)) return true;

  // The URL is a weaker signal — a path segment can contain anything — so it
  // has to look like an identifier rather than appear anywhere in the string.
  if (new RegExp(`(^|[^a-z0-9])${escapeRe(needle.replace(/\s+/g, '[-_]?'))}([^a-z0-9]|$)`, 'i').test(url)) {
    return true;
  }

  // Punctuation-insensitive form, for brands that carry it: "next.js" written
  // as "nextjs", "Hacker News" as "hackernews". Only when squashing actually
  // changes the needle, so a plain word like "bolt" never reaches this and
  // cannot match "boltt" by accident.
  const squashed = needle.replace(/[^a-z0-9]/g, '');
  if (squashed === needle || squashed.length <= 2) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRe(squashed)}([^a-z0-9]|$)`, 'i')
    .test(`${text} ${url}`.replace(/[^a-z0-9\s]/g, ''));
}

/** Does the text itself read as somebody complaining?
 *
 *  Needed because "which query found it" turned out to be nearly useless as a
 *  signal. Brave treats `OR` terms as soft preferences rather than requirements,
 *  so a query like `site:reddit.com "gimp" sucks OR terrible OR frustrating`
 *  happily returns ordinary GIMP discussion — and once the complaint pass runs
 *  a dozen such queries, almost every result in the corpus has been "found by a
 *  complaint search" and the flag marks everything.
 *
 *  The vocabulary below is the one that survived measurement against real
 *  results, and it covers the registers people actually use: blunt verdict,
 *  rhetorical question, past-tense failure event, and the polite negation or
 *  wish that means the same thing in a more measured venue. */
const COMPLAINT_LANGUAGE = new RegExp([
  // blunt verdict, and the euphemisms for it
  String.raw`\bsucks?\b`, String.raw`\b(is|are) (trash|garbage|awful|terrible|crap|crappy|rubbish|junk)\b`,
  String.raw`\bhot garbage\b`, String.raw`\bdumpster fire\b`, String.raw`\bhate[sd]? (it|this|using)?\b`,
  String.raw`\bthe worst\b`, String.raw`\bbull ?shit\b`, String.raw`\bwaste of (time|money)\b`,
  String.raw`\bnot worth it\b`, String.raw`\boverrated\b`,
  // rhetorical question
  String.raw`\bwhy (is|does|do|can'?t|would)\b.{0,40}\b(so|still|such|always)\b`,
  String.raw`\bwho (thought|decided|designed)\b`,
  // the failure as an event
  String.raw`\b(froze|frozen|crashe[sd]|crashing|hangs?|hung|locked up)\b`,
  String.raw`\b(lost|deleted) (my|all my)\b`, String.raw`\bkeeps? (crashing|freezing|failing)\b`,
  // things that stopped working
  String.raw`\b(is|are|was|were) broken\b`, String.raw`\bdoesn'?t work\b`, String.raw`\bnot working\b`,
  String.raw`\bstopped working\b`, String.raw`\bused to work\b`,
  // friction
  String.raw`\bfrustrat(ing|ed)\b`, String.raw`\bunusable\b`, String.raw`\bclunky\b`,
  String.raw`\bunintuitive\b`, String.raw`\bconfusing\b`, String.raw`\bpainful\b`,
  String.raw`\bsteep learning curve\b`, String.raw`\bhard to use\b`,
  // polite register — the same complaint from a more measured writer
  String.raw`\bdisappoint(ed|ing)\b`, String.raw`\bfalls? short\b`, String.raw`\blacks?\b`,
  String.raw`\bwish (it|they|the)\b`, String.raw`\bneeds? (better|fixing|work|improvement)\b`,
  String.raw`\bstruggl(ed|ing) with\b`, String.raw`\bgave up on\b`, String.raw`\bgiving up on\b`,
  String.raw`\bswitched away\b`, String.raw`\bnot a fan\b`,
  // the fault stated flatly, which is how people write in a support forum
  //
  // Everything above is somebody venting in public, and that is genuinely what
  // a web search surfaces. A product's own subreddit reads completely
  // differently: people describe the fault and ask how to fix it, without a
  // cross word anywhere. Measured on 159 posts and comments from r/GIMP, the
  // vocabulary above matched four of them — "black border appears when i
  // rotate" and "Layers got merged when I tried to save" are defect reports by
  // any reading and matched nothing. These patterns take the same corpus to 49.
  String.raw`\b(appears?|disappears?|vanishe[sd]|shows? up)\b.{0,30}\bwhen\b`,
  String.raw`\bgot (merged|reset|corrupted|deleted|lost|scrambled)\b`,
  String.raw`\b(won'?t|can'?t|cannot|unable to)\s+\w+`,
  String.raw`\berror\b.{0,40}\b(decoding|parsing|loading|saving|opening)\b`,
  String.raw`\bfail(s|ed|ing)? to\b`,
  String.raw`\bno way to\b`, String.raw`\bstill no\b`,
  String.raw`\bnot supported\b`, String.raw`\bcannot continue\b`,
  String.raw`\bhow (do|can) i (fix|stop|get rid of|undo)\b`,
  String.raw`\bwhy (does|is|are|do)\b.{0,50}\b(happen|happening|doing|do that)\b`,
  String.raw`\bproblem with\b`, String.raw`\bissue with\b`, String.raw`\bbug\b`,
  String.raw`\bcrash\b`, String.raw`\bfreez(e|es|ing)\b`, String.raw`\bstuck\b`,
  String.raw`\bbroken\b`, String.raw`\bglitch\b`,
].join('|'), 'i');

export const looksLikeComplaint = (hit: SearchHit): boolean =>
  complaintLanguage(`${hit.title} ${hit.description}`);

/** The same test against plain text, for sources that are not search hits.
 *
 *  Exported so that a Hacker News comment, an app-store review and a Brave
 *  result are all judged complaint-shaped by one rule. Two vocabularies would
 *  drift, and the corpus would then mean something slightly different depending
 *  on which source a mention came from — which is exactly the kind of thing
 *  nobody notices until a count looks wrong. */
export const complaintLanguage = (text: string): boolean =>
  // The non-English words are checked too, and unconditionally. A result is
  // judged before anybody has asked what language it is in, and the English
  // patterns are `\b`-anchored — which cannot match CJK text at all, because
  // there are no word boundaries in it. Without this a Chinese thread saying
  // the product keeps crashing is fetched, kept, and filed as neutral chatter.
  COMPLAINT_LANGUAGE.test(text) || anyComplaintWord(text);

/** A bare domain root is a homepage, never a specific post or thread. */
export function isHomepage(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.pathname.replace(/\/+$/, '') === '' && !parsed.search;
  } catch {
    return false;
  }
}

/** How long a result set for a query stays good. Six hours: long enough that
 *  re-running a scan while working on a downstream stage is free, short enough
 *  that a feed of "the newest discussion" is still newest. */
const SEARCH_TTL = 6 * HOUR;

/** How long a result stays good, by how narrow a window it asked for.
 *
 *  One TTL for every query was the expensive mistake. Six hours is right for
 *  "what was said in the last day" and far too short for "what was ever said
 *  about GIMP" — and the second kind is most of them. Measured on this
 *  project's own cache: 679 of 1,246 entries had aged out at six hours, and
 *  every one of those is a full-price request the next scan pays again. That is
 *  how a 2,000-query monthly allowance went in a few days of iterating.
 *
 *  The window is already part of the cache key, so scaling the TTL to it costs
 *  nothing and cannot make a fresh query stale: a `pd` search still expires in
 *  hours, because that genuinely is a different answer tomorrow. An all-time
 *  search is not. */
const TTL_BY_WINDOW: Record<string, number> = {
  pd: 6 * HOUR,
  pw: 24 * HOUR,
  pm: 3 * DAY,
  py: 7 * DAY,
  all: 7 * DAY,
};

const ttlFor = (freshness?: Freshness) => TTL_BY_WINDOW[freshness ?? 'all'] ?? SEARCH_TTL;

/** Brave's free plan has a monthly quota as well as a per-second rate limit,
 *  and 429s both of them. They need completely different responses: a rate
 *  limit clears in a second, a spent quota does not clear this month.
 *
 *  Treating them the same is why a scan kept paying a wasted round trip per
 *  query after the allowance was gone — a 0.7s request that could only fail,
 *  plus 1.1s in the pacer behind it, on every one of ~250 queries. Once Brave
 *  says the quota is spent, this stops asking and goes straight to the
 *  connectors that hold the `search` role. */
let braveQuotaSpent: { at: string; detail: string } | null = null;

export const braveExhausted = () => braveQuotaSpent;

const QUOTA_SPENT = /quota|QUOTA_LIMITED/i;

/** Brave's freshness filter: pd/pw/pm/py, or an explicit `YYYY-MM-DDtoYYYY-MM-DD`. */
export type Freshness = 'pd' | 'pw' | 'pm' | 'py' | (string & {});

/** Brave returns at most 20 results per request and paginates with `offset`,
 *  which tops out at 9 — so one query can reach ~200 results, not 20.
 *
 *  Not paginating was the single biggest reason the corpus was tiny: twenty
 *  queries could never return more than twenty results each no matter how much
 *  the internet had to say, and after overlap and filtering that is a few dozen
 *  rows about a thirty-year-old program with a large, loud user base. */
export const MAX_PAGES = 10;
export const MAX_COUNT = 20;

/** The same search, through Bright Data's SERP tool.
 *
 *  Brave's free tier is one request a second and a finite monthly quota, and a
 *  scan now issues a couple of hundred queries — so 429s are a normal operating
 *  condition rather than an outage, and losing a whole stage to one is not
 *  acceptable. Bright Data is already configured here for scraping and does
 *  search too.
 *
 *  Two things do not survive the switch, and are handled rather than hidden:
 *  freshness becomes Google's `after:` operator, which is coarser than Brave's
 *  windows but real; and pagination is a cursor rather than an offset, so a
 *  fallback returns the first page only. A thinner result from the backup beats
 *  an empty one from the primary.
 */
/** Read whatever shape a search server answered in.
 *
 *  There is no standard. Bright Data returns `{organic: [{link, title,
 *  description, date}]}`; others return `{results: [...]}`, a bare array, or
 *  `{items: [{url, snippet}]}`. Rather than a driver per server, this looks for
 *  the first array of objects that have something URL-shaped on them and reads
 *  the fields by the names they are commonly given. A server whose output it
 *  cannot read yields nothing and says so at the call site — which is the same
 *  outcome as not having it, and better than a driver that silently
 *  misinterprets a field. */
function readSearchPayload(text: string): SearchHit[] {
  let parsed: unknown;
  try {
    const body = unwrapUntrusted(text);
    const start = body.search(/[[{]/);
    if (start === -1) return [];
    parsed = JSON.parse(body.slice(start, Math.max(body.lastIndexOf('}'), body.lastIndexOf(']')) + 1));
  } catch {
    return [];
  }

  const pick = (row: Record<string, unknown>, names: string[]): string | null => {
    for (const name of names) {
      const value = row[name];
      if (typeof value === 'string' && value.trim()) return value;
    }
    return null;
  };

  const rowsOf = (value: unknown): Record<string, unknown>[] => {
    if (Array.isArray(value)) {
      return value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object');
    }
    if (value && typeof value === 'object') {
      for (const key of ['organic', 'results', 'items', 'hits', 'data', 'web']) {
        const found = rowsOf((value as Record<string, unknown>)[key]);
        if (found.length) return found;
      }
    }
    return [];
  };

  return rowsOf(parsed)
    .map((row) => {
      const url = pick(row, ['link', 'url', 'href', 'uri']);
      if (!url) return null;
      const age = pick(row, ['date', 'published', 'published_at', 'age']);
      return {
        title: cleanText(pick(row, ['title', 'name', 'heading']) ?? ''),
        url,
        description: cleanText(pick(row, ['description', 'snippet', 'summary', 'excerpt', 'text']) ?? ''),
        age,
        date: age ? parseAge(age, undefined) : null,
      };
    })
    .filter((hit): hit is SearchHit => Boolean(hit));
}

/** Ask every connector that declares the `search` role, in config order, until
 *  one answers with something.
 *
 *  This is what makes the role load-bearing rather than a label: installing an
 *  MCP search server and marking it `search` is the whole of putting it into
 *  discovery. Nothing here names a server. */
async function mcpSearch(
  query: string, freshness?: Freshness, only?: string,
): Promise<SearchHit[] | null> {
  const since = freshness === 'pd' ? 1 : freshness === 'pw' ? 7 : freshness === 'pm' ? 31 : freshness === 'py' ? 365 : 0;
  // Freshness becomes Google's `after:` operator — coarser than Brave's
  // windows but real, and understood by every general web search.
  const dated = since
    ? `${query} after:${new Date(Date.now() - since * 86_400_000).toISOString().slice(0, 10)}`
    : query;

  for (const connector of connectorsForRole('search')) {
    if (only && connector.name !== only) continue;
    const binding = bindingFor(connector, 'search');
    if (!binding) continue;
    try {
      const result = await callTool(
        connector, binding.tool, { ...(binding.extra ?? {}), [binding.arg]: dated }, 60_000,
      );
      if (result.isError) continue;
      const hits = readSearchPayload(result.text);
      if (hits.length) return hits;
    } catch (error) {
      // Try the next one — a search connector that is down is a reason to use
      // another, not a reason to fail the query. But record WHY it failed, or
      // the caller cannot tell a provider that answered "nothing" from one that
      // hung for the full timeout, and will keep paying that timeout on every
      // remaining query of the run.
      noteOutcome(connector.name, error);
    }
  }
  return null;
}

/* ---------------------------------------------------- request budget ----- */

/** A hard ceiling on paid search requests per run.
 *
 *  This exists because the pipeline's appetite is genuinely unreasonable. One
 *  scan issues 31 general plus 24 complaint queries, each re-run across up to
 *  four freshness windows and paginated up to ten pages — a measured 1,948
 *  requests across 720 distinct queries in this project's cache. On a free tier
 *  that was rude; against a metered API it is a bill.
 *
 *  A pacer alone does not fix it. Pacing decides how FAST the requests go out,
 *  and the problem is how MANY. So this counts them, and when the budget is
 *  gone the remaining queries return nothing rather than being charged for.
 *  Degrading is the right failure here: a scan with two hundred results instead
 *  of a thousand is still a scan, and it is a great deal better than an
 *  unbounded spend nobody authorised.
 *
 *  Cached queries never reach here — the cache is consulted before any of this
 *  — so the budget is spent only on genuinely new questions.
 */
const SEARCH_BUDGET = Number(process.env.SEARCH_BUDGET ?? 900);

/** A deep run is allowed to spend more. Without this the budget simply becomes
 *  the new ceiling and the extra rungs are refused one by one — the cap would
 *  have moved, not lifted. */
const budget = () => (isDeep() ? SEARCH_BUDGET * Number(process.env.DEEP_FACTOR ?? 4) : SEARCH_BUDGET);

const spent = new Map<string, number>();

/** Providers that have stopped answering, and are skipped for the rest of the
 *  run.
 *
 *  A provider that fails fast is cheap to keep trying. One that HANGS is not:
 *  Bright Data's endpoint accepted every request and then never replied, so
 *  each of a scan's queries sat out the full timeout before moving on — turning
 *  a dead provider into fifteen seconds of dead time per query, several hours
 *  across a run. Two consecutive timeouts is enough to conclude it is not
 *  answering today. */
const stalled = new Map<string, number>();
const STALL_LIMIT = 2;

let warned = false;

/** Start a fresh budget. Called at the top of a run. */
export function resetSearchBudget(): void {
  andiSpend = 0;
  andiCapped = false;
  resetRunSpend();
  spent.clear();
  stalled.clear();
  stallAnnounced.clear();
  warned = false;
}

const isStalled = (provider: string) => (stalled.get(provider) ?? 0) >= STALL_LIMIT;

function noteOutcome(provider: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  // A timeout or an aborted request is the shape that costs time. A 429 or a
  // 500 came back promptly and says nothing about whether the next one will.
  if (/timed out|timeout|aborted|AbortError|fetch failed/i.test(message)) {
    stalled.set(provider, (stalled.get(provider) ?? 0) + 1);
  } else {
    stalled.delete(provider);
  }
}

export const searchSpend = (): Record<string, number> => Object.fromEntries(spent);

const totalSpend = () => [...spent.values()].reduce((a, b) => a + b, 0);

/** Record one paid request. */
function spend(provider: string): void {
  spent.set(provider, (spent.get(provider) ?? 0) + 1);
  // The per-run tally above answers "what did this scan cost". The ledger
  // answers "can I afford to run it again", which is the question that decides
  // whether the demo still works tomorrow.
  noteSpend(provider, { requests: 1 });
}

/** True when there is no budget left. */
function overBudget(emit?: (level: 'warn', text: string) => void): boolean {
  if (totalSpend() < budget()) return false;
  if (!warned) {
    warned = true;
    emit?.('warn', `search budget of ${budget()} paid requests is spent — the rest of this run reads what is cached and what the free sources return`);
  }
  return true;
}

const stallAnnounced = new Set<string>();

/** Said once per provider per run, because the alternative is one line per
 *  query for the rest of the scan. */
function emitStall(provider: string): void {
  if (stallAnnounced.has(provider)) return;
  stallAnnounced.add(provider);
  console.warn(
    `[search] ${provider} timed out ${STALL_LIMIT} times in a row — skipping it for the rest of this run`,
  );
}

/* ------------------------------------------------------- perplexity ----- */

const PERPLEXITY_ENDPOINT = 'https://api.perplexity.ai/search';

/** Perplexity is paid per request, so it gets its own pacer.
 *
 *  Slower than Brave's, and deliberately. Brave's was set by a published rate
 *  limit; this one is set by the fact that somebody is being charged, and a
 *  runaway loop against a metered API is a bill rather than a 429. */
let perplexityGate: Promise<unknown> = Promise.resolve();
const PERPLEXITY_INTERVAL_MS = Number(process.env.PERPLEXITY_INTERVAL_MS ?? 1_200);

function pacePerplexity<T>(fn: () => Promise<T>): Promise<T> {
  const next = perplexityGate.then(fn, fn);
  perplexityGate = next.then(
    () => new Promise((r) => setTimeout(r, PERPLEXITY_INTERVAL_MS)),
    () => new Promise((r) => setTimeout(r, PERPLEXITY_INTERVAL_MS)),
  );
  return next;
}

/** Recency as Perplexity states it, rather than as a `site:`-style operator. */
const RECENCY: Record<string, string> = { pd: 'day', pw: 'week', pm: 'month', py: 'year' };

/** One Perplexity search.
 *
 *  Returns null rather than throwing when it is not configured, so it can sit
 *  in the chain harmlessly until a key exists.
 *
 *  No pagination: the API answers with up to fifty results in one request where
 *  Brave gave twenty, so a second page is both unavailable and unnecessary. An
 *  offset past the first page returns nothing rather than paying for the same
 *  fifty again. */
async function perplexitySearch(
  query: string, count: number, freshness?: Freshness, offset = 0,
): Promise<SearchHit[] | null> {
  const key = secret('PERPLEXITY_API_KEY');
  if (!key) return null;
  if (offset > 0) return [];

  return pacePerplexity(async () => {
    spend('perplexity');
    const response = await fetch(PERPLEXITY_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        max_results: Math.min(Math.max(count, 10), 50),
        ...(freshness && RECENCY[freshness] ? { search_recency_filter: RECENCY[freshness] } : {}),
      }),
      signal: abortable(30_000),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      if (response.status === 429 || response.status >= 500) {
        throw new RecoverableSearchError(`perplexity ${response.status}: ${detail.slice(0, 120)}`);
      }
      throw new Error(`perplexity ${response.status}: ${detail.slice(0, 160)}`);
    }

    const body = (await response.json()) as {
      results?: { title?: string; url?: string; snippet?: string; date?: string | null }[];
    };
    return (body.results ?? [])
      .filter((r): r is typeof r & { url: string } => Boolean(r.url))
      .map((r) => ({
        title: cleanText(r.title ?? ''),
        url: r.url,
        description: cleanText(r.snippet ?? ''),
        age: r.date ?? null,
        date: r.date ? parseAge(r.date, undefined) : null,
      }));
  });
}

/* ---------------------------------------------------------- you.com ----- */

const YOU_ENDPOINT = process.env.YDC_ENDPOINT ?? 'https://ydc-index.io/v1/search';

/** Metered like Perplexity, so paced like Perplexity, and for the same reason:
 *  the failure mode of a runaway loop here is an invoice, not a 429. */
let youGate: Promise<unknown> = Promise.resolve();
const YOU_INTERVAL_MS = Number(process.env.YDC_INTERVAL_MS ?? 1_200);

function paceYou<T>(fn: () => Promise<T>): Promise<T> {
  const next = youGate.then(fn, fn);
  youGate = next.then(
    () => new Promise((r) => setTimeout(r, YOU_INTERVAL_MS)),
    () => new Promise((r) => setTimeout(r, YOU_INTERVAL_MS)),
  );
  return next;
}

/** Move `site:` out of the query string and into the parameters.
 *
 *  This is not a nicety. you.com does not honour `site:` — it treats it as
 *  words to match on, so `site:reddit.com bolt.new bug` comes back as threads
 *  about the Bolt Pistol in Helldivers and an auto repair shop in Lexington.
 *  Every discovery query in this app is `site:`-shaped, so left alone this
 *  provider would answer all of them with plausible-looking noise, which is
 *  worse than answering none of them: the corpus fills up and nothing says the
 *  results are unrelated.
 *
 *  It does have real domain parameters, so the operator is translated rather
 *  than dropped. `-site:` becomes an exclusion the same way. What is left is
 *  the actual search terms. */
export function splitDomains(query: string): { query: string; include: string[]; exclude: string[] } {
  const include: string[] = [];
  const exclude: string[] = [];
  const rest = query.replace(/(-?)site:(\S+)/gi, (_match, negated: string, host: string) => {
    (negated ? exclude : include).push(host.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, ''));
    return '';
  });
  return { query: rest.replace(/\s+/g, ' ').trim(), include, exclude };
}

/** One you.com search.
 *
 *  Returns null when it is not configured, so it can sit in the chain
 *  harmlessly until a key exists — same contract as Perplexity.
 *
 *  Unlike Perplexity this one does paginate, so `offset` is passed through and
 *  a second page is a real second page rather than the first one billed twice.
 *  Web and news results come back in separate arrays; both are ordinary hits
 *  here, because a complaint written up as a news item is still a complaint.
 */
async function youSearch(
  query: string, count: number, freshness?: Freshness, offset = 0,
): Promise<SearchHit[] | null> {
  const key = secret('YDC_API_KEY');
  if (!key) return null;

  const asked = splitDomains(query);
  // A query that was nothing but `site:host` has no terms left to search for.
  // Brave answers that with "the recent pages on this host"; you.com has no
  // equivalent, and sending an empty query would spend a request on whatever it
  // decided to return. Declining — null, the same as "not configured" — hands
  // the query to the next provider without claiming to have answered it.
  if (!asked.query) return null;

  return paceYou(async () => {
    spend('you');
    const response = await fetch(YOU_ENDPOINT, {
      method: 'POST',
      headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: asked.query,
        count: Math.min(Math.max(count, 10), 20),
        ...(offset ? { offset } : {}),
        ...(asked.include.length ? { include_domains: asked.include } : {}),
        ...(asked.exclude.length ? { exclude_domains: asked.exclude } : {}),
        ...(freshness && RECENCY[freshness] ? { freshness: RECENCY[freshness] } : {}),
      }),
      signal: abortable(30_000),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      // 402 is the one that matters on a prepaid account: the credits are gone.
      // Treated as recoverable so the chain moves on to the next provider
      // rather than failing the whole query, which is what "out of allowance"
      // should mean everywhere.
      if (response.status === 402 || response.status === 429 || response.status >= 500) {
        throw new RecoverableSearchError(`you.com ${response.status}: ${detail.slice(0, 120)}`);
      }
      throw new Error(`you.com ${response.status}: ${detail.slice(0, 160)}`);
    }

    interface YouResult {
      title?: string; url?: string; description?: string;
      snippets?: string[]; page_age?: string | null;
    }
    const body = (await response.json()) as {
      results?: { web?: YouResult[]; news?: YouResult[] };
    };

    return [...(body.results?.web ?? []), ...(body.results?.news ?? [])]
      .filter((r): r is YouResult & { url: string } => Boolean(r.url))
      .map((r) => ({
        title: cleanText(r.title ?? ''),
        url: r.url,
        // The description is a one-liner; the snippets are the passages that
        // actually matched. Complaint detection reads this text, so the
        // passages are worth more than the summary and both are kept.
        description: cleanText([r.description ?? '', ...(r.snippets ?? [])].join(' ').trim()),
        age: r.page_age ?? null,
        date: r.page_age ? parseAge(r.page_age, undefined) : null,
      }));
  });
}

/* ---------------------------------------------------------- parallel ----- */

const PARALLEL_ENDPOINT = process.env.PARALLEL_ENDPOINT ?? 'https://api.parallel.ai/v1/search';

let parallelGate: Promise<unknown> = Promise.resolve();
const PARALLEL_INTERVAL_MS = Number(process.env.PARALLEL_INTERVAL_MS ?? 1_000);

function paceParallel<T>(fn: () => Promise<T>): Promise<T> {
  const next = parallelGate.then(fn, fn);
  parallelGate = next.then(
    () => new Promise((r) => setTimeout(r, PARALLEL_INTERVAL_MS)),
    () => new Promise((r) => setTimeout(r, PARALLEL_INTERVAL_MS)),
  );
  return next;
}

/** Page furniture that leads a scraped excerpt.
 *
 *  Parallel returns passages taken from the page rather than a search-engine
 *  snippet, which is better material — and it means the navigation comes with
 *  it. Every Reddit excerpt begins "Skip to main content Open menu Open
 *  navigation". Left in, this text is what the complaint vocabulary and the
 *  disambiguation pass read, so it is noise in the one place noise costs most. */
const CHROME = /^(?:skip to (?:main )?content|open (?:menu|navigation)|go to \w+ home|ir al contenido principal|expand (?:user )?menu|\[\]\([^)]*\))\s*/gi;

/** One Parallel search.
 *
 *  Null when unconfigured or when asked for a second page: there is no offset
 *  parameter, so paging would re-buy the first page. Declining hands the query
 *  to the next provider instead of charging for a duplicate.
 *
 *  `site:` is passed through rather than translated — the probe that verified
 *  this endpoint used `site:reddit.com` and got reddit threads back, so the
 *  operator is honoured. Unlike you.com, which reads it as words to match.
 */
async function parallelSearch(
  query: string, count: number, freshness?: Freshness, offset = 0,
): Promise<SearchHit[] | null> {
  const key = secret('PARALLEL_API_KEY');
  if (!key) return null;
  if (offset > 0) return null;

  return paceParallel(async () => {
    spend('parallel');
    const response = await fetch(PARALLEL_ENDPOINT, {
      method: 'POST',
      headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // The objective is the part no keyword engine has. It says what the
        // results are for, which is how a ranker tells a complaint thread from
        // a launch announcement that uses the same words.
        objective: 'Complaints, bug reports and problems people are having, in their own words',
        search_queries: [query],
        // Latency is the trade, and a scan issues dozens of these in sequence.
        // A deep run has already accepted that it takes longer.
        mode: isDeep() ? 'advanced' : 'fast',
      }),
      signal: abortable(60_000),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      if (response.status === 402 || response.status === 429 || response.status >= 500) {
        throw new RecoverableSearchError(`parallel ${response.status}: ${detail.slice(0, 120)}`);
      }
      throw new Error(`parallel ${response.status}: ${detail.slice(0, 160)}`);
    }

    const body = (await response.json()) as {
      results?: { url?: string; title?: string; publish_date?: string | null; excerpts?: string[] }[];
    };

    return (body.results ?? [])
      .filter((r): r is typeof r & { url: string } => Boolean(r.url))
      .slice(0, Math.max(count, 10))
      .map((r) => ({
        title: cleanText(r.title ?? ''),
        url: r.url,
        description: cleanText((r.excerpts ?? []).map((e) => e.replace(CHROME, '')).join(' ').trim()).slice(0, 1_200),
        age: r.publish_date ?? null,
        // Parallel dates most of what it returns, which the others mostly do
        // not — and a dated mention is the difference between a point on the
        // timeline and a row that can only be counted.
        date: r.publish_date ? parseAge(r.publish_date, undefined) : null,
      }));
  });
}

/* -------------------------------------------------------------- andi ----- */

const ANDI_ENDPOINT = process.env.ANDI_ENDPOINT ?? 'https://api.andiai.com/api/v1/search';

let andiGate: Promise<unknown> = Promise.resolve();
const ANDI_INTERVAL_MS = Number(process.env.ANDI_INTERVAL_MS ?? 1_200);

function paceAndi<T>(fn: () => Promise<T>): Promise<T> {
  const next = andiGate.then(fn, fn);
  andiGate = next.then(
    () => new Promise((r) => setTimeout(r, ANDI_INTERVAL_MS)),
    () => new Promise((r) => setTimeout(r, ANDI_INTERVAL_MS)),
  );
  return next;
}

/** Andi's own recency vocabulary. */
const DATE_RANGE: Record<string, string> = { pd: 'day', pw: 'week', pm: 'month', py: 'year' };

/** What this run has actually been charged, in dollars.
 *
 *  Andi returns `metrics.cost_dollars` on every response, which no other
 *  provider here does. Worth keeping: the per-run request count says how many
 *  times we asked, and this says what asking cost — and "these queries aren't
 *  free" is a great deal more actionable when the number is real money rather
 *  than a tally of requests against an allowance nobody can see. */
let andiSpend = 0;
export const searchCostDollars = (): number => andiSpend;

/** What one run may spend at Andi, in dollars.
 *
 *  A separate cap from the request budget, and it has to be, because Andi
 *  prices by outcome rather than by request: "easy lookups cost less,
 *  hard-to-find content costs more". A count of requests therefore does not
 *  bound the bill, and the whole reason to search deeper is to ask for
 *  hard-to-find content. Fifty cents a run against a five-dollar balance is ten
 *  runs, which is enough to find out whether the provider earns its place. */
const ANDI_MAX_DOLLARS = Number(process.env.ANDI_MAX_DOLLARS ?? 0.5);
let andiCapped = false;

/** One Andi search.
 *
 *  Null when unconfigured, so it sits in the chain harmlessly until a key
 *  exists — same contract as the others.
 *
 *  `site:` is translated rather than passed through. Andi does parse operators
 *  out of the query string by default, but `includeDomains` is a parameter
 *  rather than a convention, and a parameter cannot be turned off by a setting
 *  or reinterpreted by a ranker. The translation is already written and tested
 *  for you.com, so this costs nothing.
 */
async function andiSearch(
  query: string, count: number, freshness?: Freshness, offset = 0,
): Promise<SearchHit[] | null> {
  const key = secret('ANDI_API_KEY');
  if (!key) return null;
  if (andiSpend >= ANDI_MAX_DOLLARS) {
    if (!andiCapped) {
      andiCapped = true;
      console.warn(`[search] andi has spent $${andiSpend.toFixed(3)} this run — at its cap, falling through to the rest of the chain`);
    }
    return null;
  }

  const asked = splitDomains(query);
  if (!asked.query) return null;

  return paceAndi(async () => {
    spend('andi');
    const params = new URLSearchParams({
      q: asked.query,
      // Up to a hundred, where Brave gives twenty. Fewer requests for the same
      // corpus is the whole reason this is worth having.
      limit: String(Math.min(Math.max(count, 10), 50)),
      // Cost is outcome-based, so the mode is the spend dial. A daily run takes
      // whatever Andi judges sufficient; a deep run pays for the deep index.
      searchMode: isDeep() ? 'deep' : 'auto',
    });
    if (offset) params.set('offset', String(offset));
    if (freshness && DATE_RANGE[freshness]) params.set('dateRange', DATE_RANGE[freshness]);
    if (asked.include.length) params.set('includeDomains', asked.include.join(','));
    if (asked.exclude.length) params.set('excludeDomains', asked.exclude.join(','));

    const response = await fetch(`${ANDI_ENDPOINT}?${params}`, {
      headers: { 'x-api-key': key },
      signal: abortable(30_000),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      // 402 is an empty balance and 429 is going too fast. Both mean "ask
      // somebody else", which is what the chain is for — so both are
      // recoverable here even though neither is worth retrying against Andi.
      // 401 is a bad key and fails identically forever; it stops the query.
      if (response.status === 402 || response.status === 429 || response.status >= 500) {
        throw new RecoverableSearchError(`andi ${response.status}: ${detail.slice(0, 120)}`);
      }
      throw new Error(`andi ${response.status}: ${detail.slice(0, 160)}`);
    }

    const body = (await response.json()) as {
      results?: { title?: string; link?: string; url?: string; desc?: string; snippet?: string; date?: string }[];
      metrics?: { cost_dollars?: number };
    };
    const charged = Number(body.metrics?.cost_dollars) || 0;
    andiSpend += charged;
    // Recorded in dollars because Andi prices by outcome, so the request count
    // this provider also files is not what it will be billed for.
    noteSpend('andi', { dollars: charged });

    return (body.results ?? [])
      .map((r) => ({ ...r, href: r.link ?? r.url }))
      .filter((r): r is typeof r & { href: string } => Boolean(r.href))
      .map((r) => ({
        title: cleanText(r.title ?? ''),
        url: r.href,
        // `desc` is the page's own description and `snippet` is the part that
        // matched. Complaint detection reads this text, so both go in.
        description: cleanText([r.snippet ?? '', r.desc ?? ''].filter(Boolean).join(' ')),
        age: r.date ?? null,
        date: r.date ? parseAge(r.date, undefined) : null,
      }));
  });
}

/** Run a query through the search chain.
 *
 *  Named `braveSearch` for historical reasons and no longer anything of the
 *  sort — it walks whatever the `search` role holds, in the configured order,
 *  and Brave is one entry among six.
 *
 *  It used to throw when `BRAVE_API_KEY` was missing, before the chain was
 *  consulted at all. That made one provider's absence fail every search in the
 *  app while Parallel, you.com, Andi and Perplexity sat configured and idle —
 *  the exact situation the chain exists to survive, and the reason Brave's
 *  quota running out was a crisis instead of a shrug. A provider without its
 *  credential is skipped by the loop below, like any other unusable entry.
 */
export async function braveSearch(
  query: string, count = 10, freshness?: Freshness, offset = 0,
): Promise<SearchHit[]> {
  const key = secret('BRAVE_API_KEY');

  // The cache is checked outside the rate-limit gate on purpose. A cached query
  // should cost nothing at all — queueing it behind the 1.1s pacer would make a
  // forty-query scan take forty seconds to serve results it already had.
  // Freshness is part of the cache key: the same query restricted to the last
  // year is a different question with a different answer.
  const cacheKey = `brave:${count}:${freshness ?? 'all'}:${offset}:${query}`;
  return cached(`search`, cacheKey, ttlFor(freshness), async () => {
    // Checked here rather than only between stages. Discovery is hundreds of
    // queries paced at one per 1.1 seconds, so a cancel that only took effect
    // at the next stage boundary could be four minutes away — long enough that
    // the button would read as broken.
    throwIfCancelled();

    // Walk the configured chain, first choice first.
    //
    // Which provider leads is a setting now, not a fact about this function.
    // It used to be "Brave, and Bright Data if Brave errors", which was exactly
    // wrong the day Brave ran out of its monthly allowance: the dead provider
    // kept its position at the front and every query paid a round trip to
    // discover that again. The order is data, so demoting Brave is a drag
    // rather than an edit here.
    const chain = chainFor('search').filter((entry) => entry.usable);
    if (chain.length === 0) {
      throw new Error('no search provider is configured — add one under Settings → Roles');
    }
    // Checked after the cache, so a spent budget still serves everything
    // already fetched.
    if (overBudget()) return [];

    let lastError: unknown;
    // Did anybody actually run the query? An empty result from a provider that
    // searched is an answer — "nothing out there matches" — and must not be
    // reported as a broken chain. The two were conflated, and it showed the
    // moment a provider that legitimately returns nothing for a narrow
    // `site:` query led the chain: every such query logged
    // `no search provider answered`, which reads as a configuration fault.
    let answered = false;
    for (const entry of chain) {
      // `reddit` sits in the search chain because it really does search — but
      // only reddit.com, and this is the general web search path. It was being
      // walked anyway, spending a budget unit to find no MCP connector by that
      // name and return nothing. Reddit is queried directly by its own source.
      if (entry.id === 'reddit') continue;
      if (isStalled(entry.id)) continue;
      // Out of its free allowance. Skipped rather than asked: a provider whose
      // grant is spent answers with a 402 that costs a round trip to receive,
      // and the next provider in the chain was always going to serve this
      // query anyway.
      if (outOfCredit(entry.id)) continue;
      // Had its share of this run. Not a failure and not a shortage — the
      // provider is fine and will lead the next run too. It is how a scan is
      // spread across several free grants instead of emptying whichever one
      // happens to be at the top of the chain.
      if (spentItsTurn(entry.id)) continue;
      try {
        if (entry.id === 'perplexity') {
          const hits = await perplexitySearch(query, count, freshness, offset);
          if (hits) answered = true;
          if (hits && hits.length) return hits;
          continue;
        }
        if (entry.id === 'parallel') {
          const hits = await parallelSearch(query, count, freshness, offset);
          if (hits) answered = true;
          if (hits && hits.length) return hits;
          continue;
        }
        if (entry.id === 'andi') {
          const hits = await andiSearch(query, count, freshness, offset);
          if (hits) answered = true;
          if (hits && hits.length) return hits;
          continue;
        }
        if (entry.id === 'you') {
          const hits = await youSearch(query, count, freshness, offset);
          if (hits) answered = true;
          if (hits && hits.length) return hits;
          continue;
        }
        if (entry.id === 'brave') {
          // Nothing left to ask Brave with, so do not spend a round trip
          // finding that out again — but the cache above was still consulted,
          // because a spent quota does not make fetched results worthless.
          if (braveQuotaSpent) continue;
          if (!key) continue;
          spend('brave');
          // Only Brave goes through the pacer. The others have no reason to
          // queue behind a rate limit that is not theirs — when the fallback
          // ran inside this gate, every Bright Data request waited 1.1s for a
          // turn and then held the gate for its own round trip, so the escape
          // hatch inherited the exact limit it exists to escape.
          return await serialize(() => braveCall(query, key, count, freshness, offset));
        }
        spend(entry.id);
        const hits = await mcpSearch(query, freshness, entry.id);
        if (hits) answered = true;
        if (hits && hits.length) return hits;
      } catch (error) {
        // A provider that is rate limited, down or unreachable is a reason to
        // try the next one. Anything else — a rejected key, a malformed query —
        // would fail the same way everywhere, so it stops here.
        noteOutcome(entry.id, error);
        if (isStalled(entry.id)) {
          emitStall(entry.id);
        }
        if (!(error instanceof RecoverableSearchError)) throw error;
        lastError = error;
      }
    }

    // A provider ran it and found nothing. That is a result, not a failure.
    if (answered) return [];
    if (lastError) throw lastError;
    throw new Error(`no search provider answered "${query}"`);
  });
}

/** Rate limits and outages are what the backup is for. Anything else — a bad
 *  key, a malformed query — would fail the same way there, so only the
 *  recoverable ones are worth a second provider and a second wait. */
class RecoverableSearchError extends Error {}

async function braveCall(
  query: string, key: string, count: number, freshness: Freshness | undefined, offset: number,
): Promise<SearchHit[]> {
  {
    const url = `${BRAVE_ENDPOINT}?${new URLSearchParams({
      q: query,
      count: String(Math.min(count, MAX_COUNT)),
      ...(offset ? { offset: String(Math.min(offset, MAX_PAGES - 1)) } : {}),
      ...(freshness ? { freshness } : {}),
    })}`;
    // A transport failure — timeout, connection reset, DNS — is as good a
    // reason to try the other provider as a 429 is. Left unwrapped it
    // propagates as a plain Error and skips the backup entirely, which is the
    // one moment the backup is most obviously wanted.
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { 'X-Subscription-Token': key, Accept: 'application/json' },
        signal: abortable(20_000),
      });
    } catch (error) {
      throw new RecoverableSearchError(
        `brave unreachable for "${query}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      if (response.status === 429 || response.status >= 500) {
        // A 429 is two different problems wearing the same number. Brave says
        // which in the body: `QUOTA_LIMITED` with a `quota_current` past the
        // limit is the month gone, not a burst.
        if (response.status === 429) {
          const body = await response.text().catch(() => '');
          if (QUOTA_SPENT.test(body)) {
            braveQuotaSpent = { at: new Date().toISOString(), detail: body.slice(0, 300) };
          }
        }
        throw new RecoverableSearchError(`brave ${response.status} for "${query}"`);
      }
      throw new Error(`brave ${response.status} for "${query}"`);
    }

    const body = (await response.json()) as {
      web?: { results?: { title?: string; url?: string; description?: string; age?: string; page_age?: string }[] };
    };
    return (body.web?.results ?? [])
      .filter((r): r is typeof r & { url: string } => Boolean(r.url))
      .map((r) => ({
        // Brave sends escaped markup, not text: `<strong>` around the matched
        // words and every apostrophe as `&#x27;`. This is both rendered in the
        // dashboard and fed to the model as somebody's words, so it is decoded
        // once here rather than papered over at either end.
        title: cleanText(r.title ?? ''),
        url: r.url,
        description: cleanText(r.description ?? ''),
        age: r.age ?? null,
        date: parseAge(r.age, r.page_age),
      }));
  }
}

/** Windows to try, narrowest first.
 *
 *  A fixed window cannot serve both ends of the range this tool is pointed at.
 *  A company the size of Replit produces more discussion in a day than a small
 *  one does in a year: asking for the last twelve months buries today's threads
 *  under a year of accumulated relevance, while asking for the last day would
 *  return nothing at all for a quieter subject. So the window is not a setting,
 *  it is a search: start at the last 24 hours and widen only until there is
 *  enough to work with.
 *
 *  The practical effect is that the busier the company, the fresher the corpus,
 *  which is exactly the right behaviour — nobody watching a brand that is
 *  discussed hourly wants to read last spring.
 */
export const FRESHNESS_LADDER: Freshness[] = ['pd', 'pw', 'pm', 'py'];

const WINDOW_LABEL: Record<string, string> = {
  pd: 'last 24 hours',
  pw: 'last week',
  pm: 'last month',
  py: 'last year',
};

export const windowLabel = (freshness?: Freshness) =>
  (freshness ? WINDOW_LABEL[freshness] ?? freshness : 'all time');

export interface WideningResult {
  hits: SearchHit[];
  /** The window that finally satisfied the target, or the widest one tried. */
  window?: Freshness;
  /** What each rung returned, for the log — this is the line that tells you
   *  whether a thin feed means a quiet company or a broken search. */
  steps: { window: Freshness; hits: number }[];
}

/** Run the query set through progressively wider windows, stopping as soon as
 *  `target` distinct results are in hand.
 *
 *  Results accumulate rather than being replaced: a wider window is a superset,
 *  and keeping the narrower pass's copy of a URL preserves the fresher metadata
 *  the API returned for it.
 */
export async function searchWidening(
  queries: string[],
  options: {
    count?: number; target?: number; ladder?: Freshness[]; pages?: number;
    /** Walk every rung regardless of the target.
     *
     *  Stopping early is right for a daily check and wrong for "go and look
     *  properly": on an active product the first rung satisfies the target
     *  inside the last month, so the years before it are never queried at all.
     *  The target still bounds the normal path; this is what a deep run turns
     *  off. */
    exhaustive?: boolean;
  },
  onError?: (query: string, message: string) => void,
  onStep?: (window: Freshness, total: number) => void,
): Promise<WideningResult> {
  const { count = 20, target = 60, ladder = FRESHNESS_LADDER, pages = 1, exhaustive = false } = options;
  const merged = new Map<string, SearchHit>();
  const steps: { window: Freshness; hits: number }[] = [];
  let window: Freshness | undefined;

  for (const rung of ladder) {
    window = rung;
    for (const hit of await braveSearchAll(queries, count, onError, rung, pages)) {
      if (!merged.has(hit.url)) merged.set(hit.url, hit);
    }
    steps.push({ window: rung, hits: merged.size });
    onStep?.(rung, merged.size);
    if (!exhaustive && merged.size >= target) break;
  }

  return { hits: [...merged.values()], window, steps };
}

/** Run several queries and merge, keeping first-seen order and dropping repeats.
 *  A failed query is logged by the caller and skipped — one dead query is not a
 *  reason to lose the other five. */
export async function braveSearchAll(
  queries: string[],
  count: number,
  onError?: (query: string, message: string) => void,
  freshness?: Freshness,
  pages = 1,
): Promise<SearchHit[]> {
  const merged = new Map<string, SearchHit>();
  for (const query of queries) {
    for (let page = 0; page < Math.min(pages, MAX_PAGES); page += 1) {
      try {
        const hits = await braveSearch(query, count, freshness, page);
        for (const hit of hits) if (!merged.has(hit.url)) merged.set(hit.url, hit);
        // A short page is the last page; asking for the next one spends a
        // second of the rate limit to be told the same thing.
        if (hits.length < Math.min(count, MAX_COUNT)) break;
      } catch (error) {
        onError?.(query, error instanceof Error ? error.message : String(error));
        // A failure is usually a 429, and the next page of the same query will
        // fail the same way. Move to the next query rather than burning the
        // budget paging into a wall.
        break;
      }
    }
  }
  return [...merged.values()];
}

const host = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};

const onDomain = (h: string, domain: string) => h === domain || h.endsWith(`.${domain}`);

/** Platform each social/community host belongs to. */
const PLATFORM_HOSTS: [string, string][] = [
  ['x.com', 'x'], ['twitter.com', 'x'],
  ['linkedin.com', 'linkedin'],
  ['github.com', 'github'],
  ['youtube.com', 'youtube'], ['youtu.be', 'youtube'],
  ['discord.com', 'discord'], ['discord.gg', 'discord'],
  ['reddit.com', 'reddit'],
  ['instagram.com', 'instagram'],
  ['tiktok.com', 'tiktok'],
  ['facebook.com', 'facebook'],
  ['t.me', 'telegram'],
  ['mastodon.social', 'mastodon'],
  ['bsky.app', 'bluesky'],
];

export function platformOf(url: string): string | null {
  const h = host(url);
  for (const [domain, platform] of PLATFORM_HOSTS) if (onDomain(h, domain)) return platform;
  return null;
}

export function venueOf(url: string): Venue {
  const h = host(url);
  if (onDomain(h, 'reddit.com')) return 'reddit';
  if (onDomain(h, 'news.ycombinator.com')) return 'hackernews';
  if (onDomain(h, 'x.com') || onDomain(h, 'twitter.com')) return 'x';
  if (onDomain(h, 'github.com')) return 'github';
  if (onDomain(h, 'youtube.com') || onDomain(h, 'youtu.be')) return 'youtube';
  if (onDomain(h, 'discord.com') || onDomain(h, 'discord.gg')) return 'discord';
  if (onDomain(h, 'linkedin.com')) return 'linkedin';
  if (onDomain(h, 't.me')) return 'telegram';
  if (/review|trustpilot|g2\.com|capterra|producthunt/.test(h)) return 'review';
  // MetaFilter named explicitly: it is a forum by every measure that matters
  // here and by none that this pattern would catch — no "forum", "community" or
  // "discourse" anywhere in the hostname.
  if (/forum|community|discourse|stackoverflow|stackexchange|metafilter/.test(h)) return 'forum';
  if (/blog|medium\.com|substack|dev\.to|hashnode/.test(h)) return 'blog';
  return 'other';
}

/** A *profile* is an account's home, not one of its posts.
 *
 *  Search results mix the two freely — `x.com/Lovable` and
 *  `x.com/lovable_dev/status/1966590002105860114` both come back for the same
 *  query, and only the first is an account. Hashtags, topic pages, search
 *  result pages and individual threads are all rejected here; without this the
 *  presence list fills with dozens of rows that are really one account. */
export function profileHandle(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const h = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const segments = parsed.pathname.split('/').filter(Boolean);
  const first = segments[0]?.toLowerCase();

  if (onDomain(h, 'x.com') || onDomain(h, 'twitter.com')) {
    if (segments.length !== 1) return null;
    if (['hashtag', 'i', 'search', 'home', 'explore', 'intent', 'share'].includes(first!)) return null;
    return segments[0]!;
  }
  if (onDomain(h, 'linkedin.com')) {
    // Only company pages and people; not posts, news stories or product pages.
    if (segments.length === 2 && ['company', 'school', 'in'].includes(first!)) return segments[1]!;
    return null;
  }
  if (onDomain(h, 'github.com')) {
    if (segments.length !== 1) return null;
    if (['topics', 'apps', 'orgs', 'search', 'features', 'about', 'marketplace', 'sponsors'].includes(first!)) return null;
    return segments[0]!;
  }
  if (onDomain(h, 'youtube.com')) {
    if (first?.startsWith('@') && segments.length === 1) return first.slice(1);
    if (['c', 'channel', 'user'].includes(first!) && segments.length === 2) return segments[1]!;
    return null;
  }
  if (onDomain(h, 'discord.gg')) return segments.length === 1 ? segments[0]! : null;
  if (onDomain(h, 'discord.com')) {
    if (first === 'invite' && segments.length === 2) return segments[1]!;
    return null;
  }
  if (onDomain(h, 'reddit.com')) {
    // r/name and user/name only — never a specific thread.
    if (segments.length === 2 && ['r', 'user', 'u'].includes(first!)) return `${first}/${segments[1]}`;
    return null;
  }
  if (onDomain(h, 'instagram.com') || onDomain(h, 'tiktok.com')) {
    const name = first?.startsWith('@') ? first.slice(1) : first;
    if (!name || segments.length !== 1) return null;
    if (['explore', 'tags', 'p', 'reel', 'discover', 'search'].includes(name)) return null;
    return name;
  }
  if (onDomain(h, 'facebook.com')) {
    if (segments.length !== 1) return null;
    if (['sharer', 'search', 'groups', 'watch', 'pages'].includes(first!)) return null;
    return segments[0]!;
  }
  if (onDomain(h, 't.me')) {
    if (segments.length !== 1 || first === 's') return null;
    return segments[0]!;
  }
  if (onDomain(h, 'bsky.app')) {
    if (segments.length === 2 && first === 'profile') return segments[1]!;
    return null;
  }
  return null;
}

/** Pages that match a company name without being about the company.
 *
 *  A brand that is also an ordinary word ("Lovable", "Notion", "Slack") pulls
 *  dictionary entries, thesaurus pages and spelling guides into every search.
 *  Scoring those as sentiment is meaningless — they have no opinion in them —
 *  and they crowd out real discussion.
 *
 *  The listicle case is different and deliberately NOT filtered here: an
 *  "alternatives to X" roundup is weak evidence but it is still someone
 *  writing about the product. It is demoted rather than dropped — see
 *  `isOpinionBearing`. */
/** Hosts and phrasing that are never product discussion whatever the query
 *  matched.
 *
 *  Needed because a brand can share a name with an unrelated word. "GIMP" is
 *  the obvious case — the image editor and a fetish term — and a search for
 *  complaints about it returns adult directory listings that pass every other
 *  filter: they are recent, they name the brand, they are not dictionary pages.
 *  There is no sentiment about the software to read in them, so they are noise
 *  in exactly the same sense a spelling page is. */
const OFF_TOPIC_HOSTS = /porn|xxx|nsfw|fetish|escort|camgirl|onlyfans|xhamster|xvideos|redtube|pornhub|adultdeepfake|rule34|hentai|bdsm/i;
const OFF_TOPIC_TEXT = /\bporn (sites?|tube)\b|\bfetish (tube|sites?)\b|\bcam ?sites?\b|\bsex (cams?|sites?)\b|\bescort(s| service)\b|\bnsfw\b.{0,20}\b(tube|sites?)\b/i;

export function isLexicalNoise(hit: SearchHit): boolean {
  const h = host(hit.url);
  const text = `${hit.title} ${hit.description}`.toLowerCase();

  if (OFF_TOPIC_HOSTS.test(h) || OFF_TOPIC_TEXT.test(text)) return true;

  if (/merriam-webster|dictionary\.com|thesaurus|vocabulary\.com|wordnik|collinsdictionary|cambridge\.org|wiktionary|grammarly|thefreedictionary/.test(h)) {
    return true;
  }
  // "LOVABLE Definition & Meaning", "Lovable or Loveable: Which Spelling…"
  if (/\b(definition|meaning|synonym|antonym|pronunciation|spelling|how to spell|what does .{0,20} mean)\b/.test(text)) {
    return true;
  }
  if (/\bwhich spelling is correct\b|\bwhat'?s the difference\b.*\bspelling\b/.test(text)) return true;
  return false;
}

/** Does this look like somewhere a person gave an opinion, as opposed to a
 *  roundup page written for search traffic?
 *
 *  Used to order a corpus, not to censor it: real discussion should be scored
 *  and triaged first, and a vendor-comparison listicle should not outweigh ten
 *  people in a thread. */
/** Directories, marketplaces and review aggregators. Their pages are about a
 *  product but are nobody's opinion of it: the text is submitted blurbs and
 *  star averages, regenerated constantly so they always look fresh, which makes
 *  them the single most misleading thing that can reach the top of a
 *  recency-sorted brand watch. */
// Wellfound and angel.co sit here with Product Hunt for the same reason: their
// company pages are directory entries, so a hit is the product's own profile
// rather than anybody's opinion of it. Still worth searching — a discussion
// thread on one of them does turn up — but it must not be counted as discussion
// by default. MetaFilter is deliberately absent: it is threads all the way
// down, which is the whole reason to ask it.
const LISTING_HOSTS = /capterra|g2\.com|getapp|softwareadvice|trustradius|trustpilot|crozdesk|saasworthy|alternativeto|stackshare|slashdot|sourceforge|producthunt|product-hunt|wellfound|angel\.co|gartner|softwaresuggest|goodfirms|aws\.amazon\.com\/marketplace/;

/** Titles that mark a page as written for search engines rather than by someone
 *  with something to say. Deliberately aggressive: this only decides ranking,
 *  so a wrongly demoted page still appears, one place further down. */
const SEO_TITLE = new RegExp([
  String.raw`\b\d+\s+(best|top|great|popular)\b`,          // "10 best ..."
  String.raw`\b\d+\s+[\w\s]{0,24}alternatives?\b`,        // "7 Replit alternatives"
  String.raw`\bbest\s+\w+\s+alternatives?\b`,
  String.raw`\balternatives? (for|in|to)\s+20\d\d\b`,
  String.raw`\breviews?\b[^.]{0,40}\b20\d\d\b`,           // "Replit Review 2026"
  String.raw`\b20\d\d\b[^.]{0,20}\breviews?\b`,
  String.raw`\bverified reviews?\b`,
  String.raw`\bpros\b\s*(&|and|\+)\s*\bcons\b`,
  String.raw`\bwhich is (best|better)\b`,
  String.raw`\bhonest verdict\b`,
  String.raw`\b(is it worth it|should you use)\b[^.]{0,20}\?`,
  String.raw`\[20\d\d\]`,                                  // "... [2026]"
].join('|'));

/** Does this read as somebody actually discussing the product?
 *
 *  The default used to be "yes unless it is obviously a listicle", which let
 *  every "Product Review 2026" and directory listing through. That matters more
 *  than it sounds now that the corpus is ranked by recency: those pages carry a
 *  fresh date by construction, so a loose test hands them the top of the list
 *  ahead of the thing a real customer posted last week.
 */
export function isOpinionBearing(hit: SearchHit): boolean {
  const venue = venueOf(hit.url);
  // Somebody had to type it for it to exist on these.
  if (['reddit', 'hackernews', 'x', 'github', 'youtube', 'forum'].includes(venue)) return true;

  if (LISTING_HOSTS.test(host(hit.url))) return false;

  const text = `${hit.title} ${hit.description}`.toLowerCase();
  return !SEO_TITLE.test(text);
}
