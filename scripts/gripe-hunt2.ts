/** Find real, recent complaints about anything, from the places people complain.
 *  Run: npx tsx --env-file=.env scripts/gripe-hunt2.ts */
import { braveSearch } from '../app/server/search.ts';

const queries = [
  'site:reddit.com "is broken" bug',
  'site:reddit.com "doesn\'t work" app',
  'site:reddit.com "so frustrating"',
  'site:news.ycombinator.com "is broken"',
  'site:github.com "not working" issue',
];

const days = (iso: string | null) => (iso ? Math.round((Date.now() - Date.parse(iso)) / 86_400_000) : null);

for (const q of queries) {
  try {
    const hits = await braveSearch(q, 10, 'pw');
    console.log(`\n=== ${q}  (last week) — ${hits.length} hits`);
    for (const h of hits.slice(0, 4)) {
      console.log(`  ${String(days(h.date) ?? '—').padStart(3)}d  ${h.title.slice(0, 78)}`);
      console.log(`        ${h.description.replace(/\s+/g, ' ').slice(0, 150)}`);
      console.log(`        ${h.url}`);
    }
  } catch (e) {
    console.log(`\n=== ${q} FAILED — ${e instanceof Error ? e.message : e}`);
  }
}
