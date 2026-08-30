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
import { bindingFor, connectorsForRole } from './roles.ts';

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
async function hackerNews(url: string): Promise<string | null> {
  const html = await get(url);
  if (!html) return null;

  const comments = [...html.matchAll(/<div class="commtext[^"]*">([\s\S]*?)<\/div>/g)]
    .map((match) => toText(match[1]!))
    .filter((text) => text.length > 20);

  if (comments.length === 0) return null;
  return comments.join('\n\n');
}

/** Detect the bot-check interstitials that come back with HTTP 200. */
const isChallenge = (html: string) =>
  /Just a moment|Performing security verification|Checking your browser|cf-browser-verification|Enable JavaScript and cookies|<title>Blocked<\/title>/i.test(html);

export interface Fetched {
  /** The text to reason over. */
  text: string;
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

  const stored = await cached<string | null>('content', url, CONTENT_TTL, async () => {
    // Fetched unclipped so the stored copy can serve a caller that wants more
    // text than the first caller did.
    const fetched = await fetchContentUncached(url, snippet, 200_000);
    return fetched.full ? fetched.text : null;
  });

  const fetched: Fetched = stored
    ? { text: stored.slice(0, limit), full: true }
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

  // Reddit blocks this network on every route (public .json and old.reddit both
  // return its "Blocked" page), so skip the wasted request and go straight to
  // the scraper that can get through.
  if (host.endsWith('reddit.com')) {
    const scraped = await brightDataScrape(url);
    return scraped ? { text: scraped.slice(0, limit), full: true } : { text: snippet, full: false };
  }

  const html = await get(url);
  if (!html || isChallenge(html)) {
    // A bot check is exactly what Bright Data is for.
    const scraped = await brightDataScrape(url);
    return scraped ? { text: scraped.slice(0, limit), full: true } : { text: snippet, full: false };
  }

  const text = toText(html);
  // A page that strips to almost nothing is a shell, not an article.
  if (text.length < 200) return { text: snippet, full: false };
  return { text: text.slice(0, limit), full: true };
}

/** Fetch content for many URLs with bounded concurrency.
 *
 *  Bounded because these are other people's servers and this runs on every
 *  scan; unbounded parallel fetching is how you get rate limited or blocked. */
export async function fetchAll<T extends { url: string; excerpt: string }>(
  items: T[],
  onProgress: (done: number, total: number, full: number) => void,
  concurrency = 4,
  perItemLimit = 4_000,
): Promise<Map<string, Fetched>> {
  const out = new Map<string, Fetched>();
  let done = 0;
  let full = 0;

  const queue = [...items];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      const fetched = await fetchContent(item.url, item.excerpt, perItemLimit);
      out.set(item.url, fetched);
      done += 1;
      if (fetched.full) full += 1;
      if (done % 10 === 0 || done === items.length) onProgress(done, items.length, full);
    }
  });

  await Promise.all(workers);
  return out;
}
