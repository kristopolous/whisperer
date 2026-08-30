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

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

/** Bright Data's MCP endpoint, used only as the escape hatch for pages a plain
 *  fetch cannot read — Reddit, and anything behind a bot check.
 *
 *  It is a paid, metered service, so it is never the first thing tried: a
 *  direct fetch is attempted first and Bright Data is called only when that
 *  fails. TrueForge holds this credential too, but it redacts it when serving
 *  settings and exposes no endpoint for calling an MCP tool, so deterministic
 *  code needs its own copy in the environment. Without the token the pipeline
 *  degrades to search snippets for these pages rather than failing. */
const BRIGHTDATA_MCP = process.env.BRIGHTDATA_MCP_URL ?? 'https://mcp.brightdata.com/mcp';
const BRIGHTDATA_TOKEN = process.env.BRIGHTDATA_API_TOKEN;

export const brightDataAvailable = () => Boolean(BRIGHTDATA_TOKEN);

/** One MCP tools/call over streamable-http, returning the text content. */
async function brightDataScrape(url: string, timeoutMs = 60_000): Promise<string | null> {
  if (!BRIGHTDATA_TOKEN) return null;

  const call = async (body: unknown) => fetch(BRIGHTDATA_MCP, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${BRIGHTDATA_TOKEN}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  try {
    const response = await call({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'scrape_as_markdown', arguments: { url } },
    });
    if (!response.ok) return null;

    // The endpoint may answer as plain JSON or as an SSE frame; accept both.
    const raw = await response.text();
    const payload = raw.includes('data:')
      ? raw.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('')
      : raw;

    const parsed = JSON.parse(payload) as {
      result?: { content?: { type?: string; text?: string }[]; isError?: boolean };
    };
    if (parsed.result?.isError) return null;

    const text = (parsed.result?.content ?? [])
      .filter((part) => part.type === 'text' && part.text)
      .map((part) => part.text!)
      .join('\n')
      .trim();
    return text.length > 200 ? text : null;
  } catch {
    return null;
  }
}

/** Strip a fetched HTML document to readable text. */
function toText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
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
 *  for the life of the process. */
const cache = new Map<string, Fetched>();

/** Fetch one page's readable content, falling back to the snippet it came with. */
export async function fetchContent(url: string, snippet: string, limit = 4_000): Promise<Fetched> {
  const hit = cache.get(url);
  if (hit) return hit;
  const fetched = await fetchContentUncached(url, snippet, limit);
  cache.set(url, fetched);
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
