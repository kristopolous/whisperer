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
  const iso = pageAge && Date.parse(pageAge);
  if (iso && !Number.isNaN(iso)) return new Date(iso).toISOString();
  if (age) {
    const direct = Date.parse(age);
    if (!Number.isNaN(direct)) return new Date(direct).toISOString();
  }
  return null;
}

export async function braveSearch(query: string, count = 10): Promise<SearchHit[]> {
  const key = process.env.BRAVE_API_KEY;
  if (!key) throw new Error('BRAVE_API_KEY is not set — deterministic search has nothing to query');

  return serialize(async () => {
    const url = `${BRAVE_ENDPOINT}?${new URLSearchParams({ q: query, count: String(count) })}`;
    const response = await fetch(url, {
      headers: { 'X-Subscription-Token': key, Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`brave ${response.status} for "${query}"`);

    const body = (await response.json()) as {
      web?: { results?: { title?: string; url?: string; description?: string; age?: string; page_age?: string }[] };
    };
    return (body.web?.results ?? [])
      .filter((r): r is typeof r & { url: string } => Boolean(r.url))
      .map((r) => ({
        title: (r.title ?? '').replace(/<\/?strong>/g, '').trim(),
        url: r.url,
        description: (r.description ?? '').replace(/<\/?strong>/g, '').trim(),
        age: r.age ?? null,
        date: parseAge(r.age, r.page_age),
      }));
  });
}

/** Run several queries and merge, keeping first-seen order and dropping repeats.
 *  A failed query is logged by the caller and skipped — one dead query is not a
 *  reason to lose the other five. */
export async function braveSearchAll(
  queries: string[],
  count: number,
  onError?: (query: string, message: string) => void,
): Promise<SearchHit[]> {
  const merged = new Map<string, SearchHit>();
  for (const query of queries) {
    try {
      for (const hit of await braveSearch(query, count)) {
        if (!merged.has(hit.url)) merged.set(hit.url, hit);
      }
    } catch (error) {
      onError?.(query, error instanceof Error ? error.message : String(error));
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
  if (onDomain(h, 't.me')) return 'telegram';
  if (/review|trustpilot|g2\.com|capterra|producthunt/.test(h)) return 'review';
  if (/forum|community|discourse|stackoverflow|stackexchange/.test(h)) return 'forum';
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
export function isLexicalNoise(hit: SearchHit): boolean {
  const h = host(hit.url);
  const text = `${hit.title} ${hit.description}`.toLowerCase();

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
export function isOpinionBearing(hit: SearchHit): boolean {
  const venue = venueOf(hit.url);
  if (['reddit', 'hackernews', 'x', 'github', 'youtube', 'forum'].includes(venue)) return true;

  const text = `${hit.title} ${hit.description}`.toLowerCase();
  // "10 best alternatives", "top 7 tools", "X vs Y compared" — SEO roundups.
  if (/\b\d+\s+(best|top|great|popular)\b|\bbest\s+\w+\s+alternatives?\b|\balternatives? (for|in|to)\s+20\d\d\b/.test(text)) {
    return false;
  }
  return true;
}
