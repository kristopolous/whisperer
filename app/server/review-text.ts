/** The reviews behind a score.
 *
 *  A scorecard row saying Trustpilot 1.8/5 is the beginning of a question, not
 *  an answer. What makes it actionable is the twenty people who wrote why —
 *  and those are on the page we already know the address of, so there is no
 *  reason to make somebody open a tab to read them.
 *
 *  Read out of JSON-LD rather than scraped from the markup. Review sites all
 *  publish `Review` objects for search engines — it is the one thing they
 *  reliably agree on — so a single reader covers Trustpilot, Product Hunt, G2,
 *  Capterra and anything else that wants to appear in a rich result. Scraping
 *  each one's markup would be five parsers that break on five schedules.
 *
 *  Nothing here infers. A review with no body is skipped rather than
 *  reconstructed from its rating: the point of showing these is that they are
 *  what somebody actually wrote.
 */

import type { ReviewSnippet } from '../shared/types.ts';
import { cleanText, decodeEntities, stripTags } from '../shared/html.ts';

interface Node { [key: string]: unknown }

const text = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') {
    const node = value as Node;
    if (typeof node.name === 'string') return node.name.trim();
  }
  return '';
};

/** A rating out of whatever scale the review states, normalised to 5.
 *
 *  Scales differ — Trustpilot is out of 5, some sites are out of 10 — and a 7
 *  read as 7/5 would render as a glowing review of something people hate. */
function ratingOf(node: Node): number | null {
  const rating = node.reviewRating as Node | undefined;
  if (!rating) return null;
  const value = Number(rating.ratingValue);
  if (!Number.isFinite(value)) return null;
  const best = Number(rating.bestRating) || 5;
  if (best <= 0) return null;
  return Math.round((value / best) * 5 * 10) / 10;
}

/** Every `Review` in a JSON-LD document, however deeply it is nested.
 *
 *  Walked rather than pattern-matched: reviews hang off `Product`,
 *  `Organization`, `SoftwareApplication` and `@graph` depending on the site,
 *  and a regex for `"reviewBody"` would also pick up the schema examples some
 *  pages embed. */
function walk(node: unknown, out: Node[], depth = 0): void {
  if (depth > 8 || !node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, out, depth + 1);
    return;
  }
  const record = node as Node;
  const type = record['@type'];
  const isReview = typeof type === 'string'
    ? /review/i.test(type) && !/aggregate/i.test(type)
    : Array.isArray(type) && type.some((t) => typeof t === 'string' && /review/i.test(t));
  if (isReview && (record.reviewBody || record.description)) out.push(record);
  for (const value of Object.values(record)) walk(value, out, depth + 1);
}

/** Recent reviews from a review-site page.
 *
 *  Newest first where the reviews carry dates, because a 1.8 average earned two
 *  years ago and a 1.8 earned last month are different situations. */
export function reviewsFrom(html: string, limit = 6): ReviewSnippet[] {
  if (!html) return [];

  const nodes: Node[] = [];
  for (const block of html.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      walk(JSON.parse(block[1]!.trim()), nodes);
    } catch {
      // A malformed block is one publisher's problem, not a reason to give up
      // on the others on the page.
    }
  }

  const seen = new Set<string>();
  const reviews: ReviewSnippet[] = [];
  for (const node of nodes) {
    const body = text(node.reviewBody) || text(node.description);
    if (body.length < 15) continue;
    const key = body.slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);

    const when = text(node.datePublished) || text(node.dateCreated);
    const date = when && Number.isFinite(new Date(when).getTime()) ? new Date(when).toISOString() : null;

    reviews.push({
      author: text(node.author) || null,
      rating: ratingOf(node),
      date,
      title: text(node.name) || null,
      // Publishers put markup inside `reviewBody` — Product Hunt wraps every
      // review in `<p>`. Rendering that raw would show somebody the tags.
      body: cleanText(decodeEntities(stripTags(body))).slice(0, 600),
    });
  }

  return reviews
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
    .slice(0, limit);
}

/** The site's own aggregate rating, from its JSON-LD.
 *
 *  This is the number the site publishes about itself. Everything on the
 *  scorecard used to be read out of a search result's snippet — a rating found
 *  in text near the word "Capterra" is not Capterra's rating, and printing it
 *  as one is a claim we cannot support. Where the page states it, that is what
 *  should be shown; where it does not, we should say so rather than fall back
 *  to the snippet and hope.
 */
export function aggregateFrom(html: string): { rating: number; scale: number; count: number | null } | null {
  if (!html) return null;

  for (const block of html.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block[1]!.trim());
    } catch {
      continue;
    }

    const queue: unknown[] = [parsed];
    for (let guard = 0; queue.length && guard < 400; guard += 1) {
      const node = queue.shift();
      if (Array.isArray(node)) { queue.push(...node); continue; }
      if (!node || typeof node !== 'object') continue;
      const record = node as Node;

      const agg = record.aggregateRating as Node | undefined;
      if (agg) {
        const rating = Number(agg.ratingValue);
        const scale = Number(agg.bestRating) || 5;
        const count = Number(agg.reviewCount ?? agg.ratingCount);
        // A rating outside its own scale is a misparse, not a score.
        if (Number.isFinite(rating) && rating >= 0 && scale > 0 && rating <= scale) {
          return { rating, scale, count: Number.isFinite(count) && count > 0 ? count : null };
        }
      }
      for (const value of Object.values(record)) if (value && typeof value === 'object') queue.push(value);
    }
  }
  return null;
}

/** Reviews out of the markdown a scraper returns.
 *
 *  The fallback, and only reached when the JSON-LD is gone. Trustpilot blocks a
 *  direct fetch, so its page arrives through the scraper as markdown with every
 *  `<script>` — and therefore every `Review` object — stripped out. The reviews
 *  are still all there in the prose, in a regular shape:
 *
 *      \[Cameron Ross
 *      Apr 6, 2026
 *      ]\(/users/69d3b590…)
 *      Rated 3 out of 5 stars
 *      Replit starts off great builds a basic app very quickly, but…
 *
 *  One pattern rather than a parser per site. It is matched on the "Rated N out
 *  of 5 stars" line, which is Trustpilot's own wording — if that changes this
 *  returns nothing and the panel says the reviews could not be read, which is
 *  the correct failure. It does not guess. */
export function reviewsFromMarkdown(markdown: string, limit = 6): ReviewSnippet[] {
  if (!markdown) return [];

  // Anchored on "Rated N out of M stars", which is Trustpilot's own wording.
  // If that changes this returns nothing and the panel says the reviews could
  // not be read — the correct failure, rather than a guess.
  const pattern = /\\?\[([^\n\]]{1,60})\n+((?:Updated\s+)?[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})\n+\][^\n]*\n+Rated\s+(\d+(?:\.\d+)?)\s+out of\s+\d+\s+stars\n+([\s\S]*?)(?=\n\s*(?:Useful|Share)\b|$)/g;

  const out: ReviewSnippet[] = [];
  for (const match of markdown.matchAll(pattern)) {
    const [, author, when, rating, raw] = match;
    // "… See more" is the truncation the page itself shows; keeping it would
    // put an interface artefact inside somebody's quoted words.
    const body = cleanText((raw ?? '').replace(/\.\.\.\s*See more\s*$/i, '').trim());
    if (body.length < 15) continue;
    const parsed = new Date((when ?? '').replace(/^Updated\s+/i, ''));
    out.push({
      author: (author ?? '').trim() || null,
      rating: Number.isFinite(Number(rating)) ? Number(rating) : null,
      date: Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null,
      title: null,
      body: body.slice(0, 600),
    });
  }

  return out.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')).slice(0, limit);
}

/** Whatever the page turns out to be. */
export const readReviews = (page: string, limit = 6): ReviewSnippet[] => {
  const structured = reviewsFrom(page, limit);
  return structured.length ? structured : reviewsFromMarkdown(page, limit);
};
