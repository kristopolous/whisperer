/** Fetch what people actually wrote, rather than scoring a search snippet.
 *
 *  A Brave result carries a ~200 character meta description. For a Hacker News
 *  thread that is the submission blurb; for a review page it is marketing copy.
 *  Scoring sentiment over that is really scoring SEO text — it is why four
 *  near-identical "best alternatives" roundups came back at -0.30, -0.20, 0.00
 *  and 0.00, and why triage found no complaints in sixty mentions.
 *
 *  So before the model sees a corpus, the discussion pages in it are fetched and
 *  their real text extracted. What is reachable from here, measured rather than
 *  assumed:
 *
 *    - Hacker News: a plain fetch of an item page yields every comment
 *      (74 on a single thread in testing). Best source available.
 *    - Ordinary web pages: fetch and strip to text. Works unless the site sits
 *      behind a bot check.
 *    - Reddit: blocked on every route tried — the public `.json` endpoints and
 *      old.reddit both return Reddit's "Blocked" page, and the OAuth
 *      credentials in .env are empty so token requests 401. Reddit mentions
 *      keep their search snippet and are labelled as such, rather than being
 *      silently passed off as full text.
 */

import { cleanText } from '../shared/html.ts';
import { usableConnectors } from './config.ts';
import { callTool } from './mcp.ts';
import { cached, DAY } from './cache.ts';
import { bindingFor } from './roles.ts';
import { connectorsForRole } from './providers.ts';
import { abortable } from './run-context.ts';
import { publishedAt } from './published.ts';

/** The date a URL's own path implies, for the readers that return structured
 *  text and never see the page's markup. */
const fromUrlOnly = (url: string) => publishedAt('', url);
import { fetchRedditPage, redditDate } from './reddit.ts';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';


/** Whether the scraping escape hatch is usable at all. Without it, Reddit and
 *  anything behind a bot check keep their search snippet instead of the text
 *  somebody actually wrote. */
export const brightDataAvailable = () => connectorsForRole('scrape').length > 0;

/** Scrape one page through whichever connector declares the `scrape` role.
 *
 *  Named by role rather than by vendor, so installing a different scraper is a
 *  settings change instead of an edit here. They are tried in config order and
 *  the first that returns a real page wins — a scraper that is down or blocked
 *  on this domain is a reason to try the next, not to give up on the page.
 *
 *  Delegates to the shared MCP client rather than keeping a second, subtly
 *  different implementation here. The bespoke one this replaces authenticated
 *  with a Bearer header (Bright Data wants the token on the URL) and never
 *  performed the MCP handshake (it answers 400 without a session), so it failed
 *  two different ways at once and each masked the other.
 */
async function brightDataScrape(url: string, timeoutMs = 60_000): Promise<string | null> {
  for (const connector of connectorsForRole('scrape')) {
    const binding = bindingFor(connector, 'scrape');
    if (!binding) continue;
    try {
      const result = await callTool(
        connector, binding.tool, { ...(binding.extra ?? {}), [binding.arg]: url }, timeoutMs,
      );
      if (result.isError) continue;
      const page = unwrapUntrusted(result.text);
      if (isScraperError(page)) continue;
      if (page.length > 200) return page;
    } catch {
      // A scrape that cannot be done is a page we fall back to a snippet for,
      // not a reason to fail the stage.
    }
  }
  return null;
}

/** Bright Data reporting its own failure, in the body, with a 200.
 *
 *  These come back as ordinary content: a scrape of Trustpilot returns
 *  "Residential Failed (bad_endpoint): Requested site is not available for
 *  immediate residential (no KYC) access mode…" and nothing about the response
 *  says it is an error. Left alone it is stored as the page, scored for
 *  sentiment, and quoted to a model as what somebody wrote — so a site we
 *  cannot read looks like a site with 253 characters of strange opinion on it.
 *
 *  Matched on the specific shapes rather than by length, because a genuinely
 *  short page is not an error. */
const SCRAPER_ERRORS = [
  /^Residential Failed/i,
  /^Requested site is not available/i,
  /\bbad_endpoint\b/i,
  /^Error: (?:socket hang up|tunneling socket)/i,
  /^Unexpected server response/i,
  /^Access to this (?:page|site) (?:has been )?denied/i,
];

export const isScraperError = (text: string): boolean =>
  SCRAPER_ERRORS.some((pattern) => pattern.test(text.trim()));

/** Take the page out of Bright Data's provenance envelope.
 *
 *  Every scrape comes back wrapped in a "SECURITY NOTICE ... the content
 *  between the markers below was fetched from an external, untrusted web
 *  source" preamble, followed by =====UNTRUSTED_<id>_BEGIN===== and END
 *  markers around the actual page.
 *
 *  Leaving it in was quietly ruinous. The scoring stage trims each item to 900
 *  characters of text, and the preamble alone is around 600 — so for a short
 *  thread the model was reading a security notice and a marker, scoring the
 *  sentiment of a boilerplate warning, and the person's actual words never
 *  reached it.
 *
 *  The warning's substance still holds and is handled where it belongs: this
 *  text is data, never instructions. It is fed to a classifier that is asked
 *  what it says, and nothing in the pipeline acts on its contents. Stripping
 *  the envelope removes the label, not the discipline.
 */
export function unwrapUntrusted(text: string): string {
  const marked = text.match(/=====UNTRUSTED_[0-9a-f]+_BEGIN=====([\s\S]*?)=====UNTRUSTED_[0-9a-f]+_END=====/);
  if (marked) return marked[1]!.trim();

  // Truncation can cut the closing marker off. Take everything after the
  // opening one rather than returning a page that is all preamble.
  const opened = text.match(/=====UNTRUSTED_[0-9a-f]+_BEGIN=====([\s\S]*)$/);
  if (opened) return opened[1]!.trim();

  return text.trim();
}

/** Strip a fetched HTML document to readable text.
 *
 *  Script, style and noscript bodies go first — their contents are not prose
 *  and stripping only the tags would leave the code behind. Everything after
 *  that is the shared treatment in app/shared/html.ts, so a page and a search
 *  snippet are decoded the same way. */
function toText(html: string): string {
  return cleanText(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' '),
  );
}

async function get(url: string, timeoutMs = 15_000): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

/** Every comment on a Hacker News item, newest-page order, joined. */
/** A Hacker News thread, through the API rather than the page.
 *
 *  The scrape it replaces read `<div class="commtext">` out of the HTML, which
 *  missed the submission text entirely and only ever saw the comments the first
 *  page happened to render — measured across the cache, 15 of 85 HN fetches came
 *  back as nothing and the median was 890 characters for what is often a
 *  hundred-comment thread.
 *
 *  There was never a reason to scrape it. Algolia's index is what the search
 *  side of this app already queries, it serves the whole comment tree at
 *  `/items/{id}`, it needs no key, and Hacker News does not guard it. */
async function hackerNews(url: string): Promise<string | null> {
  const id = (() => {
    try {
      return new URL(url).searchParams.get('id');
    } catch {
      return null;
    }
  })();
  if (!id || !/^\d+$/.test(id)) return null;

  interface Item {
    title?: string | null;
    text?: string | null;
    author?: string | null;
    type?: string;
    children?: Item[];
  }

  let root: Item;
  try {
    const response = await fetch(`https://hn.algolia.com/api/v1/items/${id}`, {
      headers: { 'User-Agent': 'whisperer' },
      signal: abortable(20_000),
    });
    if (!response.ok) return null;
    root = (await response.json()) as Item;
  } catch {
    return null;
  }

  // Depth-first, so a reply stays under what it replies to — the thread reads
  // as a conversation rather than as a bag of sentences, which is what makes a
  // complaint and its rebuttal distinguishable.
  const out: string[] = [];
  const walk = (item: Item, depth: number) => {
    const body = toText(item.text ?? '');
    if (body.length > 20) out.push(`${'  '.repeat(Math.min(depth, 4))}${item.author ? `${item.author}: ` : ''}${body}`);
    for (const child of item.children ?? []) walk(child, depth + 1);
  };

  if (root.title) out.push(root.title);
  walk(root, 0);
  return out.length ? out.join('\n\n') : null;
}

/** Is this a Discourse forum, and if so read the topic through its JSON.
 *
 *  Discourse serves the whole post stream for any topic by appending `.json` to
 *  its URL — no key, no login, no scraper. Every product that runs its own
 *  support forum on it was therefore reachable all along, and 17 of 17 fetches
 *  of `replit.discourse.group` came back as a 318-character search snippet.
 *  That is the highest-value corpus there is for this product: a company's own
 *  forum is where faults get described in detail, by people who came
 *  specifically to describe them.
 *
 *  Recognised by the URL shape rather than by a probe. `/t/<slug>/<id>` is
 *  Discourse's topic route and is distinctive enough; a wrong guess costs one
 *  request that 404s and falls through to the ordinary path. */
const DISCOURSE_TOPIC = /\/t\/[^/]+\/(\d+)(?:\/\d+)?\/?$/;

async function discourse(url: string): Promise<string | null> {
  if (!DISCOURSE_TOPIC.test(new URL(url).pathname)) return null;

  interface Post { cooked?: string; username?: string }
  let body: { title?: string; post_stream?: { posts?: Post[] } };
  try {
    const target = url.replace(/\/?$/, '').replace(/\.json$/, '') + '.json';
    const response = await fetch(target, {
      headers: { Accept: 'application/json', 'User-Agent': 'whisperer' },
      signal: abortable(20_000),
    });
    if (!response.ok) return null;
    const parsed: unknown = await response.json();
    if (!parsed || typeof parsed !== 'object') return null;
    body = parsed as typeof body;
  } catch {
    return null;
  }

  const posts = body.post_stream?.posts ?? [];
  if (posts.length === 0) return null;

  const out = body.title ? [body.title] : [];
  for (const post of posts) {
    const text = toText(post.cooked ?? '');
    if (text.length > 20) out.push(`${post.username ? `${post.username}: ` : ''}${text}`);
  }
  return out.length ? out.join('\n\n') : null;
}

/** Detect the bot-check interstitials that come back with HTTP 200. */
const isChallenge = (html: string) =>
  /Just a moment|Performing security verification|Checking your browser|cf-browser-verification|Enable JavaScript and cookies|<title>Blocked<\/title>/i.test(html);

export interface Fetched {
  /** The text to reason over. */
  text: string;
  /** When the page says it was published, when it says.
   *
   *  Read off the page rather than taken from whatever the search provider
   *  returned, because the providers mostly return nothing: a third of one real
   *  corpus was undated, which put it outside every timeline while the headline
   *  count still included it. */
  date?: string | null;
  /** True when this is real page content; false when it is the search snippet
   *  because the page could not be read. The caller must not present a snippet
   *  as if it were someone's words. */
  full: boolean;
}

/** Pages already fetched during this scan.
 *
 *  Buzz, health and abuse all reason over overlapping slices of the same
 *  corpus. Without this each stage would re-fetch the same threads from the
 *  same servers minutes apart, which is slow and rude. Keyed by URL and kept
 *  for the life of the process; the disk cache below it survives restarts. */
const memo = new Map<string, Fetched>();

/** A thread's text a week later is the same thread's text, near enough — and
 *  the comments that arrived since are not worth re-fetching every page in the
 *  corpus to catch. */
const CONTENT_TTL = 7 * DAY;

/** Fetch one page's readable content, falling back to the snippet it came with.
 *
 *  Only successful full reads are cached to disk. A snippet fallback means the
 *  fetch failed — a bot check, a timeout, a 429 — and remembering that failure
 *  for a week would turn a momentary block into a permanently empty page. */
export async function fetchContent(url: string, snippet: string, limit = 4_000): Promise<Fetched> {
  const hit = memo.get(url);
  if (hit) return hit;

  const stored = await cached<{ text: string; date: string | null } | string | null>(
    'content', url, CONTENT_TTL, async () => {
      // Fetched unclipped so the stored copy can serve a caller that wants more
      // text than the first caller did.
      const got = await fetchContentUncached(url, snippet, 200_000);
      return got.full ? { text: got.text, date: got.date ?? null } : null;
    },
  );

  // Entries written before the date was extracted are bare strings. Read both
  // rather than invalidating the cache: those are pages already paid for, and
  // the text in them is exactly as good as it was.
  const body = typeof stored === 'string' ? { text: stored, date: null } : stored;

  const fetched: Fetched = body
    ? { text: body.text.slice(0, limit), full: true, date: body.date }
    : { text: snippet, full: false };
  memo.set(url, fetched);
  return fetched;
}

async function fetchContentUncached(url: string, snippet: string, limit: number): Promise<Fetched> {
  const host = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  })();

  if (host === 'news.ycombinator.com') {
    const text = await hackerNews(url);
    if (text) return { text: text.slice(0, limit), full: true };
    return { text: snippet, full: false };
  }

  // Reddit blocks this network on every unauthenticated route (public .json
  // and old.reddit both return its "Blocked" page), so a plain fetch is a
  // wasted request.
  //
  // The API comes first when credentials are set: it is free, it returns the
  // thread structured rather than as scraped HTML, and it saves a metered
  // request. Every reddit.com page used to go straight to the paid scraper —
  // for a site we hold credentials to.
  if (host.endsWith('reddit.com')) {
    const viaApi = await fetchRedditPage(url);
    if (viaApi) return { text: viaApi.text.slice(0, limit), full: true, date: viaApi.date };
    const scraped = await brightDataScrape(url);
    return scraped ? { text: scraped.slice(0, limit), full: true } : { text: snippet, full: false };
  }

  // Discourse forums, which are a product's own support site more often than
  // not. Tried before the plain fetch because the HTML is a JavaScript shell
  // that strips to nothing.
  const viaDiscourse = await discourse(url).catch(() => null);
  if (viaDiscourse) return { text: viaDiscourse.slice(0, limit), full: true, date: fromUrlOnly(url) };

  const html = await get(url);
  if (!html || isChallenge(html)) {
    // A bot check is exactly what Bright Data is for.
    const scraped = await brightDataScrape(url);
    return scraped
      ? { text: scraped.slice(0, limit), full: true, date: publishedAt(scraped, url) }
      : { text: snippet, full: false, date: fromUrlOnly(url) };
  }

  // Read the date before deciding whether the text is usable.
  //
  // A YouTube watch page strips to almost nothing and is rejected below as a
  // shell — correctly, there is no article in it — but it carries
  // `datePublished` in its markup all the same. Twenty of twenty-one YouTube
  // mentions in one corpus were undated for exactly this reason: the page was
  // fetched, judged unreadable, and thrown away with the date still in it.
  const date = publishedAt(html, url);

  const text = toText(html);
  // A page that strips to almost nothing is a shell, not an article.
  if (text.length < 200) return { text: snippet, full: false, date };
  return { text: text.slice(0, limit), full: true, date };
}

/** Fetch content for many URLs with bounded concurrency.
 *
 *  Bounded because these are other people's servers and this runs on every
 *  scan; unbounded parallel fetching is how you get rate limited or blocked. */
/** The page's markup, cached, for readers that need the document rather than
 *  the prose — JSON-LD lives in `<script>` tags that text extraction strips.
 *
 *  Falls through to the scraper on a bot check, because a review site is
 *  exactly the kind of page that serves one. */
export async function fetchRawHtml(url: string, viaScraper = false): Promise<string | null> {
  return cached<string | null>(viaScraper ? 'html-scraped' : 'html', url, CONTENT_TTL, async () => {
    // `viaScraper` skips the direct fetch entirely. Needed because a login wall
    // and a consent page are not bot challenges — they return a real, ordinary
    // document that is simply not the page — so `isChallenge` passes them
    // through and the caller gets 11KB of Glassdoor asking you to sign in. The
    // caller knows it got nothing useful; this is how it says so.
    if (!viaScraper) {
      const html = await get(url, 20_000);
      if (html && !isChallenge(html)) return html;
    }
    const scraped = await brightDataScrape(url);
    return scraped ?? null;
  });
}

/** Does this item still need a date? */
const isDateless = (item: { date?: string | null }) => !item.date;

/** The publication date of a page, fetched and cached on its own.
 *
 *  Separate from the content cache on purpose. That cache holds pages fetched
 *  before dates were extracted — as bare strings, with no date and no markup
 *  left to read one from — and it short-circuits before any HTML is fetched, so
 *  those entries could never gain one. Discarding them to force a refetch would
 *  throw away text that was paid for; this asks the one extra question instead,
 *  once per URL, and keeps the answer for a month.
 *
 *  Null is a real answer and is cached as one: a page that genuinely does not
 *  say when it was published should be asked once, not on every scan. */
export const publishedDateFor = async (url: string): Promise<string | null> => {
  // Free without a request when the path carries it.
  const fromPath = publishedAt('', url);
  if (fromPath) return fromPath;

  // Reddit refuses this network unauthenticated, so a plain fetch would answer
  // null and then cache that null for a month — for the venue that is half the
  // corpus and whose API we hold credentials to.
  if (/(^|\.)reddit\.com$/i.test(new URL(url).hostname)) {
    return await redditDate(url).catch(() => null);
  }

  const hit = await cached<string | null>('published', url, 30 * DAY, async () => {
    const html = await get(url).catch(() => null);
    return publishedAt(html ?? '', url);
  });
  return hit ?? null;
};

export async function fetchAll<T extends { url: string; excerpt: string; date?: string | null }>(
  items: T[],
  onProgress: (done: number, total: number, full: number, dated?: number) => void,
  concurrency = 4,
  perItemLimit = 4_000,
): Promise<Map<string, Fetched>> {
  const out = new Map<string, Fetched>();
  let done = 0;
  let full = 0;
  let dated = 0;

  const queue = [...items];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      const fetched = await fetchContent(item.url, item.excerpt, perItemLimit);
      out.set(item.url, fetched);
      // Backfill. Whichever stage fetched this first, every later one — and the
      // stored record, and every timeline drawn from it — gets the date. Only
      // when the mention has none: a date the source itself reported is better
      // than one read off a page that may be a listing or a mirror.
      if (isDateless(item)) {
        // What the fetch already saw, else one extra look. The second path is
        // what rescues everything cached before dates were read at all.
        const when = fetched.date ?? await publishedDateFor(item.url).catch(() => null);
        if (when) {
          (item as { date?: string | null }).date = when;
          dated += 1;
        }
      }
      done += 1;
      if (fetched.full) full += 1;
      if (done % 10 === 0 || done === items.length) onProgress(done, items.length, full, dated);
    }
  });

  await Promise.all(workers);
  return out;
}
