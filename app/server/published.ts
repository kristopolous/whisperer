/** When a page says it was published.
 *
 *  A third of one real corpus — 279 mentions of 848 — carried no date, and the
 *  charts quietly drew themselves on the two thirds that did while the headline
 *  count reported all of it. The reason was not that the internet is undated.
 *  YouTube puts `datePublished` in the watch page, every blog engine writes
 *  `article:published_time`, and news and article pages carry JSON-LD with a
 *  date in it. We were taking whatever the search provider happened to return
 *  and giving up when it returned nothing.
 *
 *  So: read it off the page we already fetched. Deterministic, no model, and
 *  ordered by how much each source can be trusted — an explicit publication
 *  meta tag beats a `<time>` element somewhere in the body, which beats a date
 *  in the URL.
 *
 *  Everything here refuses more readily than it guesses. A wrong date is worse
 *  than no date: it puts somebody's complaint in the wrong month, and the
 *  timeline is the one panel whose whole job is saying when things happened.
 */

/** Plausible as a publication date for something we are watching now.
 *
 *  Rejects the two failure modes that produce garbage: a parse that lands in
 *  1970 because a numeric field was read as seconds, and a future date from a
 *  scheduled post or a mis-parsed `DD/MM`. Twenty-five years back is generous
 *  enough for an old forum thread and tight enough to catch nonsense. */
function plausible(date: Date): boolean {
  const time = date.getTime();
  if (!Number.isFinite(time)) return false;
  const now = Date.now();
  return time > now - 25 * 365 * 86_400_000 && time < now + 2 * 86_400_000;
}

const iso = (value: string | number | undefined | null): string | null => {
  if (value === undefined || value === null || value === '') return null;
  // A bare number is a unix timestamp — in seconds if it is ten digits, in
  // milliseconds if thirteen. Guessing wrong lands in 1970 or the year 55000,
  // which `plausible` then rejects.
  const raw = typeof value === 'number' || /^\d{9,14}$/.test(String(value).trim())
    ? new Date(Number(value) * (String(value).trim().length <= 11 ? 1_000 : 1))
    : new Date(String(value).trim());
  return plausible(raw) ? raw.toISOString() : null;
};

/** `<meta>` names and properties that mean "this was published then", in
 *  descending order of how explicitly they say it. */
const META_KEYS = [
  'article:published_time',
  'article:published',
  'datepublished',
  'date',
  'dc.date.issued',
  'dc.date',
  'parsely-pub-date',
  'sailthru.date',
  'pubdate',
  'publish-date',
  'og:published_time',
  'article:modified_time',
  'og:updated_time',
];

function fromMeta(html: string): string | null {
  // One pass over every meta tag, then pick by preference — rather than a
  // regex per key over the whole document, which is fifteen scans of a
  // 200KB page.
  const found = new Map<string, string>();
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const key = (
      /\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? ''
    ).toLowerCase().trim();
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (key && content && !found.has(key)) found.set(key, content);
  }
  for (const key of META_KEYS) {
    const value = iso(found.get(key));
    if (value) return value;
  }
  return null;
}

/** JSON-LD, which is where most publishers put the authoritative date.
 *
 *  Walked rather than pattern-matched: the date can be at the top level, inside
 *  `@graph`, or on one entry of an array, and a regex for `"datePublished"`
 *  would happily pick one out of an unrelated nested object like a comment. */
function fromJsonLd(html: string): string | null {
  const KEYS = ['datePublished', 'uploadDate', 'dateCreated', 'dateModified'];

  for (const block of html.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block[1]!.trim());
    } catch {
      continue;
    }

    // Breadth-first, so a date on the outer article wins over one on a nested
    // comment or author object.
    const queue: unknown[] = [parsed];
    const hits: Record<string, string> = {};
    for (let guard = 0; queue.length && guard < 500; guard += 1) {
      const node = queue.shift();
      if (Array.isArray(node)) {
        queue.push(...node);
        continue;
      }
      if (!node || typeof node !== 'object') continue;
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (KEYS.includes(key) && !hits[key] && (typeof value === 'string' || typeof value === 'number')) {
          const when = iso(value);
          if (when) hits[key] = when;
        } else if (value && typeof value === 'object') {
          queue.push(value);
        }
      }
    }
    for (const key of KEYS) if (hits[key]) return hits[key]!;
  }
  return null;
}

/** A `<time datetime="...">`, which is what hand-rolled templates and most
 *  forums emit. The first one on the page is the post's own. */
function fromTimeElement(html: string): string | null {
  for (const match of html.matchAll(/<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)["']/gi)) {
    const when = iso(match[1]);
    if (when) return when;
  }
  return null;
}

/** A date in the path — `/2026/04/why-it-broke`. Last resort, and only ever
 *  month precision, because that is genuinely all it says. */
function fromUrl(url: string): string | null {
  const match = /\/(20\d{2})\/(\d{1,2})(?:\/(\d{1,2}))?(?:\/|$)/.exec(url);
  if (!match) return null;
  const [, year, month, day] = match;
  return iso(`${year}-${String(month).padStart(2, '0')}-${String(day ?? '01').padStart(2, '0')}T12:00:00Z`);
}

/** The publication date of a page, or null when it genuinely does not say.
 *
 *  Order is the trust ordering: JSON-LD and publication meta tags are the
 *  publisher stating it, a `<time>` element is a template that usually means
 *  it, and a path segment is an inference. */
export function publishedAt(html: string, url = ''): string | null {
  if (!html) return fromUrl(url);
  return fromJsonLd(html)
    ?? fromMeta(html)
    ?? fromTimeElement(html)
    ?? fromUrl(url);
}
