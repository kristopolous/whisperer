/** Does search still work when Brave is rate-limited?
 *  Run: npx tsx --env-file=.env scripts/search-fallback-check.ts */
import { braveSearch } from '../app/server/search.ts';

for (const q of ['site:reddit.com crawl4ai', '"crawl4ai" broken']) {
  const started = Date.now();
  try {
    const hits = await braveSearch(q, 8);
    console.log(`${String(hits.length).padStart(2)} hits  ${Math.round((Date.now() - started) / 1000)}s  ${q}`);
    for (const h of hits.slice(0, 2)) console.log(`      ${h.title.slice(0, 66)}`);
  } catch (e) {
    console.log(` failed  ${q} — ${e instanceof Error ? e.message.slice(0, 70) : e}`);
  }
}
