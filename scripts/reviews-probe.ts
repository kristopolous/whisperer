/** Can we get review-site scores at all, and are they machine-readable?
 *  Run: npx tsx --env-file=.env scripts/reviews-probe.ts [domain] */
import { fetchContent } from '../app/server/content.ts';

const domain = process.argv[2] ?? 'replit.com';
const urls = [
  `https://www.trustpilot.com/review/${domain}`,
  `https://www.g2.com/products/${domain.split('.')[0]}/reviews`,
  `https://www.capterra.com/p/search/?q=${domain.split('.')[0]}`,
];

for (const url of urls) {
  const started = Date.now();
  const got = await fetchContent(url, '(none)', 20_000);
  const text = got.text.replace(/\s+/g, ' ');
  // What a scorecard needs: a rating, a scale, and how many people voted.
  const rating = text.match(/([0-5](?:[.,]\d)?)\s*(?:out of|\/)\s*5/i)?.[1]
    ?? text.match(/\bTrustScore\s*([0-5](?:[.,]\d)?)/i)?.[1];
  const count = text.match(/([\d,]{2,})\s*(?:reviews?|ratings?)/i)?.[1];
  console.log(`${got.full ? 'FULL   ' : 'blocked'}  ${Math.round((Date.now() - started) / 1000)}s  ${String(got.text.length).padStart(5)}ch  rating=${rating ?? '—'} count=${count ?? '—'}  ${url}`);
}
