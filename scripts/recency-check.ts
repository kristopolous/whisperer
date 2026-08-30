/** Does the freshness pass actually surface newer discussion?
 *  Run: npx tsx --env-file=.env scripts/recency-check.ts [company] */
import { braveSearch } from '../app/server/search.ts';

const company = process.argv[2] ?? 'replit';
const queries = [`site:reddit.com ${company}`, `"${company}" broken`, `"${company}" review`];

const age = (iso: string | null) =>
  iso ? `${Math.round((Date.now() - Date.parse(iso)) / 86_400_000)}d` : 'undated';

for (const query of queries) {
  for (const freshness of [undefined, 'py' as const]) {
    const hits = await braveSearch(query, 10, freshness);
    const dated = hits.filter((h) => h.date);
    const newest = dated.map((h) => h.date!).sort().at(-1) ?? null;
    console.log(
      `${(freshness ?? 'all-time').padEnd(8)} ${query.padEnd(28)} `
      + `${hits.length} hits, ${dated.length} dated, newest ${age(newest)}`,
    );
  }
}
