/** Which complaint phrasings actually return complaints?
 *  Run: npx tsx --env-file=.env scripts/query-check.ts [brand] */
import { braveSearch } from '../app/server/search.ts';

const brand = process.argv[2] ?? 'gimp';

const candidates = [
  // blunt verdicts
  `"${brand} sucks"`,
  `"${brand} is trash" OR "${brand} is garbage"`,
  `"${brand} is awful" OR "${brand} is terrible"`,
  `"hate ${brand}" OR "i hate using ${brand}"`,
  `"${brand} is the worst"`,
  // rhetorical
  `"why is ${brand} so"`,
  `"why does ${brand}" annoying OR stupid OR terrible`,
  `"who thought" ${brand}`,
  `"what happened to ${brand}"`,
  // regression / change
  `"the new ${brand}" bad OR worse OR ruined`,
  `"${brand}" "used to work"`,
  `"${brand}" ruined OR regression`,
  // giving up
  `"${brand}" "gave up" OR "giving up on"`,
  `"switching away from ${brand}" OR "done with ${brand}"`,
  // the old helpdesk-style ones, for comparison
  `"${brand}" "not working"`,
  `"${brand}" bug OR crash OR error`,
];

const GRIPE = /suck|trash|garbage|awful|terrible|hate|worst|stupid|annoying|ruin|frustrat|clunky|unusable|confus|why is|why does|gave up|hot mess|nightmare|painful/i;

for (const q of candidates) {
  try {
    const hits = await braveSearch(q, 10);
    const gripes = hits.filter((h) => GRIPE.test(`${h.title} ${h.description}`));
    console.log(`${String(hits.length).padStart(2)} hits ${String(gripes.length).padStart(2)} gripey  ${q}`);
    if (gripes[0]) console.log(`                      e.g. ${gripes[0].title.slice(0, 84)}`);
  } catch (e) {
    console.log(` FAILED                ${q} — ${e instanceof Error ? e.message.slice(0, 40) : e}`);
  }
}
