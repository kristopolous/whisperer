/** Public review-site scores, read out of search snippets.
 *
 *  What a business checks weekly is not whether anyone is impersonating them —
 *  that is rare — it is what their score says on the sites buyers look at.
 *
 *  No scraping. The review sites defend themselves hard: Trustpilot returns 403
 *  to a plain fetch and is refused by our scraping provider without a KYC form,
 *  because it is excluded by robots.txt. But the score is right there in the
 *  search result — "Replit currently holds a 3.1 out of 5 on Trustpilot across
 *  nearly 1,500 reviews" — so one search per site gets the number for free, and
 *  is a deterministic HTTP call with no model in it.
 *
 *  Provenance is tracked because it varies. Searching Trustpilot for one
 *  product returned 2.9 from Trustpilot's own page and 3.1 from an article
 *  quoting it. The site's own page is the number; anything else is hearsay and
 *  is labelled as such rather than averaged in.
 */

import type { ReviewKind, ReviewScore } from '../shared/types.ts';
import { readReviews } from './review-text.ts';
import { fetchRawHtml } from './content.ts';
import { braveSearch, type SearchHit } from './search.ts';

interface Site {
  name: string;
  /** Hosts that count as the site's own page. */
  hosts: RegExp;
  scale: number;
  kind: ReviewKind;
}

/** Where a public score lives, grouped by the kind of reputation it measures.
 *
 *  Software review sites are the obvious ones, but they are not the whole
 *  picture: a company's rating with its customers (Trustpilot, BBB, Sitejabber),
 *  its users (App Store, Play), and its own staff (Glassdoor, Indeed) are three
 *  different reputations, and a business is judged on all of them. */
const SITES: Site[] = [
  // Buyers of software.
  { name: 'G2', hosts: /(^|\.)g2\.com$/i, scale: 5, kind: 'software' },
  { name: 'Capterra', hosts: /(^|\.)capterra\.[a-z.]+$/i, scale: 5, kind: 'software' },
  { name: 'GetApp', hosts: /(^|\.)getapp\.[a-z.]+$/i, scale: 5, kind: 'software' },
  { name: 'TrustRadius', hosts: /(^|\.)trustradius\.com$/i, scale: 10, kind: 'software' },
  { name: 'Software Advice', hosts: /(^|\.)softwareadvice\.[a-z.]+$/i, scale: 5, kind: 'software' },
  { name: 'PeerSpot', hosts: /(^|\.)peerspot\.com$/i, scale: 10, kind: 'software' },
  { name: 'Gartner Peer Insights', hosts: /(^|\.)gartner\.com$/i, scale: 5, kind: 'software' },
  { name: 'Product Hunt', hosts: /(^|\.)producthunt\.com$/i, scale: 5, kind: 'software' },
  { name: 'AlternativeTo', hosts: /(^|\.)alternativeto\.net$/i, scale: 5, kind: 'software' },

  // Customers of the company.
  { name: 'Trustpilot', hosts: /(^|\.)trustpilot\.com$/i, scale: 5, kind: 'customer' },
  { name: 'Sitejabber', hosts: /(^|\.)sitejabber\.com$/i, scale: 5, kind: 'customer' },
  { name: 'BBB', hosts: /(^|\.)bbb\.org$/i, scale: 5, kind: 'customer' },

  // People who use the app on a phone.
  { name: 'App Store', hosts: /(^|\.)apps\.apple\.com$/i, scale: 5, kind: 'app' },
  { name: 'Google Play', hosts: /(^|\.)play\.google\.com$/i, scale: 5, kind: 'app' },

  // People who work there. A collapsing Glassdoor score is a reputation
  // problem that shows up in hiring long before it shows up in sales.
  { name: 'Glassdoor', hosts: /(^|\.)glassdoor\.[a-z.]+$/i, scale: 5, kind: 'employer' },
  { name: 'Indeed', hosts: /(^|\.)indeed\.[a-z.]+$/i, scale: 5, kind: 'employer' },
];

/** Ways a rating is written in a snippet, most explicit first. The order
 *  matters: "4.5 out of 5" is unambiguous, a bare "rated 4.5" is not, and a
 *  star glyph is the weakest of the three. */
const RATING_PATTERNS = [
  /([0-9](?:[.,][0-9])?)\s*(?:out of|\/)\s*(5|10)\b/i,
  /\b(?:TrustScore|Trust Score)\s*(?:of\s*)?([0-9](?:[.,][0-9])?)/i,
  /\b(?:rated|rating of|score of|holds a)\s*([0-9](?:[.,][0-9])?)\s*(?:stars?|\/|out)?/i,
  /★\s*([0-9](?:[.,][0-9])?)/,
];

const COUNT_PATTERNS = [
  /\b(?:across|from|by|on)\s*(?:nearly|over|about|more than)?\s*([\d][\d,.]{1,9})\s*(?:verified\s*)?(?:reviews?|ratings?)/i,
  /\b([\d][\d,.]{1,9})\s*(?:verified\s*)?(?:reviews?|ratings?)\b/i,
];

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

/** Pages that carry someone else's score.
 *
 *  A roundup lists a dozen products with their ratings, and a comparison page
 *  carries two. Reading a number off either attributes a competitor's score to
 *  this brand — which is how "Top 10 Notion Alternatives" produced a 4.6 from
 *  11,994 reviews that belongs to something else entirely. */
const OTHER_PRODUCTS = /\balternatives?\b|\bcompetitors?\b|\bvs\.?\s|\btop\s+\d+\b|\bbest\s+\d+\b|\bcomparison\b/i;

/** Pull a score out of one search result, if it carries one.
 *
 *  The checks here are all about attribution rather than parsing. Getting a
 *  number out of a snippet is easy; the failures are all cases where the number
 *  was real and belonged to somebody else. */
function readScore(hit: SearchHit, site: Site, brand: string, domain: string): ReviewScore | null {
  const text = `${hit.title} ${hit.description}`.replace(/\s+/g, ' ');

  // The page has to be about this brand. A review site's domain is not enough:
  // it hosts a page for every product it covers.
  const needle = brand.toLowerCase().trim();
  const boundary = new RegExp(`(^|[^a-z])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i');
  if (!boundary.test(hit.title) && !boundary.test(hit.url)) return null;

  // And it has to be about this brand ALONE.
  if (OTHER_PRODUCTS.test(hit.title)) return null;

  // Trustpilot keys its pages on the domain — /review/<host> — which makes the
  // right entity checkable rather than inferred. Without this, "Notion" matched
  // trustpilot.com/review/getnotion.com, a defunct and unrelated company whose
  // page says so in its own snippet, and reported its 3.2 as Notion's score.
  if (domain && /trustpilot\.com$/i.test(hostOf(hit.url))) {
    const reviewed = hit.url.match(/\/review\/([^/?#]+)/i)?.[1]?.toLowerCase();
    if (reviewed && reviewed.replace(/^www\./, '') !== domain) return null;
  }

  let rating: number | null = null;
  let scale = site.scale;
  for (const pattern of RATING_PATTERNS) {
    const found = text.match(pattern);
    if (!found) continue;
    rating = Number(found[1]!.replace(',', '.'));
    if (found[2]) scale = Number(found[2]);
    break;
  }

  // A rating outside its scale is a misread — a price, a version number, a year
  // fragment — not a score.
  if (rating === null || !Number.isFinite(rating) || rating < 0 || rating > scale) return null;

  let count: number | null = null;
  for (const pattern of COUNT_PATTERNS) {
    const found = text.match(pattern);
    if (!found) continue;
    const parsed = Number(found[1]!.replace(/[,.]/g, ''));
    if (Number.isFinite(parsed) && parsed > 0) { count = parsed; break; }
    }

  const firstParty = site.hosts.test(hostOf(hit.url));

  // A number quoted somewhere else must at least name the site it is quoting.
  // Without this, searching "Product Hunt <brand> reviews" happily returned a
  // G2 article and filed its 4.3 under Product Hunt — a real number, attributed
  // to a site that never gave it.
  if (!firstParty && !new RegExp(site.name.replace(/\s+/g, '\\s*'), 'i').test(text)) return null;

  return {
    site: site.name,
    rating,
    scale,
    count,
    url: hit.url,
    firstParty,
    quote: text.slice(0, 220),
    kind: site.kind,
  };
}

/** One search per review site, and the best score each one yields.
 *
 *  Deterministic and cheap: six searches, no page fetches, no model call. */
/** The page on a review site that actually holds the reviews.
 *
 *  A search result for "Indeed Replit reviews" is as likely to be the company's
 *  interview page or its seller profile as the reviews themselves — and those
 *  pages carry the rating in their header, so the score reads correctly while
 *  the reviews behind it are somewhere else entirely. Measured on one scan:
 *  Indeed pointed at `/cmp/Replit/interviews` and G2 at `/sellers/replit`, and
 *  both returned a page with no reviews on it.
 *
 *  Rewritten only within the same host, and only where the site's own URL shape
 *  is unambiguous. Anything unrecognised is left exactly as found — guessing a
 *  path is how you turn a working link into a 404.
 */
export function reviewPageFor(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    const path = parsed.pathname.replace(/\/+$/, '');

    // Indeed: /cmp/<company>/<section> — the section is what varies.
    const indeed = /^indeed\.com$/i.test(host) && /^\/cmp\/([^/]+)/.exec(path);
    if (indeed) return `https://www.indeed.com/cmp/${indeed[1]}/reviews`;

    // G2: a seller profile is not the product's reviews.
    const seller = /^g2\.com$/i.test(host) && /^\/sellers\/([^/]+)/.exec(path);
    if (seller) return `https://www.g2.com/products/${seller[1]}/reviews`;
    const g2product = /^g2\.com$/i.test(host) && /^\/products\/([^/]+)$/.exec(path);
    if (g2product) return `https://www.g2.com/products/${g2product[1]}/reviews`;

    // Product Hunt: the product page carries the score, /reviews carries the text.
    const ph = /^producthunt\.com$/i.test(host) && /^\/products\/([^/]+)$/.exec(path);
    if (ph) return `https://www.producthunt.com/products/${ph[1]}/reviews`;

    // Capterra: same shape.
    const capterra = /^capterra\.com$/i.test(host) && /^\/p\/(\d+)\/([^/]+)$/.exec(path);
    if (capterra) return `https://www.capterra.com/p/${capterra[1]}/${capterra[2]}/reviews/`;

    return url;
  } catch {
    return url;
  }
}

export async function findReviewScores(
  brand: string,
  /** The company's own site, when known. Lets pages keyed on the domain be
   *  matched to the right entity rather than to a similarly-named one. */
  site: string,
  emit: (level: 'info' | 'warn', text: string) => void,
): Promise<ReviewScore[]> {
  const domain = hostOf(site);
  const found: ReviewScore[] = [];

  for (const reviewSite of SITES) {
    try {
      const hits = await braveSearch(`${reviewSite.name} ${brand} reviews`, 8);
      const scores = hits
        .map((hit) => readScore(hit, reviewSite, brand, domain))
        .filter((s): s is ReviewScore => s !== null);
      if (scores.length === 0) continue;

      // The site's own page wins over anyone quoting it; then a stated review
      // count, because a rating with no n behind it is far more often a number
      // lifted out of prose than a real aggregate.
      scores.sort((a, b) =>
        Number(b.firstParty) - Number(a.firstParty)
        || Number(b.count !== null) - Number(a.count !== null)
        || (b.count ?? 0) - (a.count ?? 0));
      found.push(scores[0]!);
    } catch (error) {
      emit('warn', `${reviewSite.name} lookup failed — ${error instanceof Error ? error.message.slice(0, 80) : 'error'}`);
    }
  }

  // Then the reviews behind every number.
  //
  // Every one, with no threshold and no first-party filter. Both were my
  // inventions to save requests, and they defeated the point of the panel: a
  // score with no reviews under it is a number to take on trust, which is the
  // one thing this whole product exists not to ask of anybody. A 4.5 needs its
  // reviews as much as a 1.0 — that is how you find out the 4.5 is four years
  // old, or that the recent ones are all 1s.
  for (const score of found) {
    try {
      score.url = reviewPageFor(score.url);
      // The raw document, not the extracted text. Reviews are read out of
      // JSON-LD, and text extraction strips `<script>` — so reading the
      // prose version would find nothing and look like a site that publishes
      // no reviews.
      let html = await fetchRawHtml(score.url);
      let recent = readReviews(html ?? '');

      // Nothing readable on the page we were served? Try the scraper before
      // concluding the site has no reviews. Glassdoor, Indeed and G2 answer a
      // plain request with a sign-in or consent page — a real document, not a
      // bot challenge, so it passes every "is this a challenge" test and the
      // reviews simply are not in it.
      if (recent.length === 0) {
        html = await fetchRawHtml(score.url, true);
        recent = readReviews(html ?? '');
      }

      if (recent.length) {
        score.recent = recent;
        emit('info', `${score.site}: ${recent.length} recent reviews behind ${score.rating}/${score.scale}`);
      } else {
        emit('info', `${score.site}: no readable reviews on the page behind ${score.rating}/${score.scale}`);
      }
    } catch {
      // A missing review body never costs the score it belongs to.
    }
  }

  const hearsay = found.filter((s) => !s.firstParty).length;
  emit(
    'info',
    `review scores: ${found.length} of ${SITES.length} sites`
    + (hearsay ? ` (${hearsay} quoted second-hand, not from the site itself)` : ''),
  );
  return found;
}
