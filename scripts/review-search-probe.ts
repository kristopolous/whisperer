/** Do search snippets carry the score, so we never have to scrape the site?
 *  Run: npx tsx --env-file=.env scripts/review-search-probe.ts [brand] */
import { braveSearch } from '../app/server/search.ts';

const brand = process.argv[2] ?? 'replit';
const sites = ['trustpilot', 'g2', 'capterra', 'trustradius', 'getapp'];

for (const site of sites) {
  const hits = await braveSearch(`${site} ${brand} reviews`, 5);
  console.log(`\n=== ${site} ${brand}`);
  for (const h of hits.slice(0, 3)) {
    const text = `${h.title} ${h.description}`.replace(/\s+/g, ' ');
    const rating = text.match(/([0-5][.,]\d)\s*(?:out of|\/)\s*5/i)?.[1]
      ?? text.match(/(?:TrustScore|rated|rating of)\s*([0-5][.,]?\d?)/i)?.[1]
      ?? text.match(/★\s*([0-5][.,]\d)/)?.[1];
    const count = text.match(/([\d,]{2,})\s*(?:reviews?|ratings?)/i)?.[1];
    console.log(`  ${rating ? `★ ${rating}` : '  —  '} ${count ? `(${count})` : ''}  ${h.title.slice(0, 62)}`);
    if (rating || count) console.log(`        "${text.slice(0, 150)}"`);
  }
}
