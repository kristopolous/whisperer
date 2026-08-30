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
import { bindingFor, connectorsForRole } from './roles.ts';
import { abortable, throwIfCancelled } from './run-context.ts';
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
].join('|'), 'i');

export const looksLikeComplaint = (hit: SearchHit): boolean =>
  COMPLAINT_LANGUAGE.test(`${hit.title} ${hit.description}`);

/** The same test against plain text, for sources that are not search hits.
 *
 *  Exported so that a Hacker News comment, an app-store review and a Brave
 *  result are all judged complaint-shaped by one rule. Two vocabularies would
 *  drift, and the corpus would then mean something slightly different depending
 *  on which source a mention came from — which is exactly the kind of thing
 *  nobody notices until a count looks wrong. */
export const complaintLanguage = (text: string): boolean => COMPLAINT_LANGUAGE.test(text);

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
  query: string, freshness?: Freshness,
): Promise<SearchHit[] | null> {
  const since = freshness === 'pd' ? 1 : freshness === 'pw' ? 7 : freshness === 'pm' ? 31 : freshness === 'py' ? 365 : 0;
  // Freshness becomes Google's `after:` operator — coarser than Brave's
  // windows but real, and understood by every general web search.
  const dated = since
    ? `${query} after:${new Date(Date.now() - since * 86_400_000).toISOString().slice(0, 10)}`
    : query;

  for (const connector of connectorsForRole('search')) {
    const binding = bindingFor(connector, 'search');
    if (!binding) continue;
    try {
      const result = await callTool(
        connector, binding.tool, { ...(binding.extra ?? {}), [binding.arg]: dated }, 60_000,
      );
      if (result.isError) continue;
      const hits = readSearchPayload(result.text);
      if (hits.length) return hits;
    } catch {
      // Try the next one. A search connector that is down is a reason to use
      // another, not a reason to fail the query.
    }
  }
  return null;
}

export async function braveSearch(
  query: string, count = 10, freshness?: Freshness, offset = 0,
): Promise<SearchHit[]> {
  const key = secret('BRAVE_API_KEY');
  if (!key) throw new Error('BRAVE_API_KEY is not set — add it in Settings, or export it, or search has nothing to query');

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
    // Nothing is left to ask Brave with, so do not spend a round trip finding
    // that out again. The cache is still consulted above, which is the point —
    // an exhausted quota does not make already-fetched results worthless.
    if (braveQuotaSpent) {
      const backup = await mcpSearch(query, freshness);
      if (backup && backup.length) return backup;
      throw new Error(`brave's monthly quota is spent and no search connector answered "${query}"`);
    }

    try {
      return await serialize(() => braveCall(query, key, count, freshness, offset));
    } catch (error) {
      // The backup runs OUTSIDE the gate, which is the whole point of it.
      //
      // It used to run inside: the fallback was invoked from within the
      // serialized Brave call, so every Bright Data request queued behind
      // Brave's one-per-1.1s pacer AND held that pacer for its own round trip.
      // The escape hatch inherited the exact rate limit it exists to escape,
      // and a run that was 429ing on every query — which is what a large scan
      // does — paid 1.1s of dead time before each backup call and blocked every
      // other query while it ran. Out here the two providers are independent,
      // and Brave being throttled costs nothing but Brave.
      if (error instanceof RecoverableSearchError) {
        const backup = await mcpSearch(query, freshness);
        if (backup && backup.length) return backup;
      }
      throw error;
    }
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
  options: { count?: number; target?: number; ladder?: Freshness[]; pages?: number },
  onError?: (query: string, message: string) => void,
  onStep?: (window: Freshness, total: number) => void,
): Promise<WideningResult> {
  const { count = 20, target = 60, ladder = FRESHNESS_LADDER, pages = 1 } = options;
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
    if (merged.size >= target) break;
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
