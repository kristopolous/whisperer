/** The scorecard's honesty, pinned to the shapes the sites actually serve.
 *
 *  Every fixture below is a trimmed excerpt of a real page, kept verbatim
 *  including its escaping, because the thing being tested is tolerance of one
 *  specific publisher's wording. A fixture rewritten to be tidy tests nothing.
 *
 *  What this file is really guarding is the rule that a score is only shown when
 *  the site itself stated it. The tempting failure — reading any rating-shaped
 *  number out of any page — is covered explicitly by the Trustpilot sidebar
 *  case, where six other companies' TrustScores sit on the page and none of
 *  them is the answer.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateFrom, readReviews, reviewsFromIndeed, statedFrom } from './review-text.ts';

const TRUSTPILOT = `[Software Company](/categories/software_company)

replit.com Reviews 

1,534

•

TrustScore 3 out of 5

2.9

[Write a review](/evaluate/replit.com)`;

// The rail Trustpilot puts on every profile. Whichever company is being looked
// at, five others' scores are on the page in the same words.
const NEIGHBOURS = `Companies you might like

vercel.com

TrustScore 4.5 out of 5

anthropic.com

TrustScore 1.5 out of 5

`;

const INDEED = `Replit

4.0 out of 5 stars.4.0

Follow

\\[

1

Reviews]\\(/cmp/Replit/reviews)

Working at Replit: 1 Review

Overall rating

4.0

Based on 1 review

February 14, 2023

[Impact but lots of work](/cmp/Replit/reviews/impact-but-lots-of-work?id=b8a359fd6742ffcc)

Engineer

San Francisco, CA

It's a fun experience and environment. But you will have to work long hours.

Was this review helpful?`;

test('reads the subject of a Trustpilot page, not the companies beside it', () => {
  const url = 'https://www.trustpilot.com/review/replit.com';

  // The neighbours come first, so a reader that takes the first TrustScore it
  // finds returns 4.5 — a glowing score for a company rated 2.9.
  const stated = statedFrom(NEIGHBOURS + TRUSTPILOT, url);
  assert.deepEqual(stated, { rating: 2.9, scale: 5, count: 1534 });
});

test('prefers the exact average over the rounded TrustScore', () => {
  // "TrustScore 3 out of 5" is what the stars draw; 2.9 is the figure. The
  // difference is the whole reason to read the page rather than the stars.
  const stated = statedFrom(TRUSTPILOT, 'https://www.trustpilot.com/review/replit.com');
  assert.equal(stated?.rating, 2.9);
});

test('a Trustpilot page for another company is not this company', () => {
  // Anchoring is on the domain in the URL, so a page fetched for one company
  // cannot be read as another's score.
  assert.equal(statedFrom(TRUSTPILOT, 'https://www.trustpilot.com/review/bolt.new'), null);
});

test('reads Indeed, including a rating built on a single review', () => {
  const url = 'https://www.indeed.com/cmp/Replit/reviews';
  assert.deepEqual(statedFrom(INDEED, url), { rating: 4, scale: 5, count: 1 });

  // n=1 is not a defect to hide. A 4.0 from one person and a 4.0 from a
  // thousand are different facts, and the count is what tells them apart.
  const reviews = reviewsFromIndeed(INDEED);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0]?.title, 'Impact but lots of work');
  assert.equal(reviews[0]?.author, 'Engineer, San Francisco, CA');
  assert.match(reviews[0]?.body ?? '', /work long hours/);
  assert.equal(reviews[0]?.date?.slice(0, 10), '2023-02-14');
});

test('readReviews falls through to Indeed when neither other reader matches', () => {
  assert.equal(readReviews(INDEED).length, 1);
});

test('a page that states nothing yields nothing', () => {
  // The correct failure. A site that changes its wording must produce "not
  // readable", never a number lifted from somewhere else on the page.
  assert.equal(statedFrom('Sign in to continue', 'https://www.indeed.com/cmp/Replit/reviews'), null);
  assert.equal(statedFrom('', 'https://www.trustpilot.com/review/replit.com'), null);
  assert.equal(aggregateFrom('<html><body>4.5 out of 5</body></html>'), null);
});

test('an aggregate outside its own scale is a misparse, not a score', () => {
  const ld = (rating: number, best: number) =>
    `<script type="application/ld+json">${JSON.stringify({
      '@type': 'Product', aggregateRating: { ratingValue: rating, bestRating: best, reviewCount: 52 },
    })}</script>`;
  assert.deepEqual(aggregateFrom(ld(4.56, 5)), { rating: 4.56, scale: 5, count: 52 });
  assert.equal(aggregateFrom(ld(9.2, 5)), null);
});
