/** Does the crawl agent find accounts on sites with different layouts?
 *  Run: npx tsx --env-file=.env scripts/crawl-check.ts [company] [site] */
import { crawlSite } from '../app/server/agents/crawl-run.ts';

const pairs: [string, string][] = process.argv[2]
  ? [[process.argv[2], process.argv[3]!]]
  : [['Crawl4AI', 'https://crawl4ai.com'], ['GIMP', 'https://www.gimp.org']];

for (const [company, site] of pairs) {
  console.log(`\n=== ${company} — ${site}`);
  const started = Date.now();
  const r = await crawlSite(company, site, (l, t) => console.log(`  [${l}] ${t}`));
  console.log(`  ${r.pagesRead} page(s) in ${Math.round((Date.now() - started) / 1000)}s`);
  for (const p of r.profiles) {
    console.log(`    ${p.official ? 'official  ' : 'community '} ${p.platform.padEnd(10)} ${p.handle.slice(0, 28).padEnd(28)} ${p.url.slice(0, 54)}`);
  }
  if (r.notes) console.log(`  notes: ${r.notes.slice(0, 160)}`);
}
