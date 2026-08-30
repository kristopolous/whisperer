/** What the scorecard would show. Run: npx tsx --env-file=.env scripts/reviews-check.ts [brand...] */
import { findReviewScores } from '../app/server/reviews.ts';

const SITES: Record<string,string> = { replit:'https://replit.com', notion:'https://notion.so', gimp:'https://www.gimp.org' };

for (const brand of (process.argv.slice(2).length ? process.argv.slice(2) : ['replit', 'notion', 'gimp'])) {
  console.log(`\n=== ${brand}`);
  const scores = await findReviewScores(brand, SITES[brand] ?? '', (l, t) => console.log(`  [${l}] ${t}`));
  for (const s of scores) {
    console.log(`  ${s.kind.padEnd(9)} ${s.site.padEnd(22)} ${String(s.rating).padStart(4)}/${s.scale}${s.count ? `  n=${String(s.count).padEnd(7)}` : '  n=?      '} ${s.firstParty ? 'own page' : 'quoted'}`);
  }
  if (scores.length === 0) console.log('  no scores found');
}
