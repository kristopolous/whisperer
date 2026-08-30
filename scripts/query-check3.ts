import { braveSearch } from '../app/server/search.ts';
const brand = process.argv[2] ?? 'gimp';

const candidates = [
  `"${brand} froze" OR "${brand} crashed"`,
  `"${brand} keeps freezing" OR "${brand} keeps crashing"`,
  `"${brand} deleted my" OR "${brand} lost my"`,
  `"${brand} is crap" OR "${brand} is crappy"`,
  `"${brand} is junk" OR "${brand} is rubbish"`,
  `"${brand} is a joke" OR "${brand} is a mess"`,
  `"${brand}" "hot garbage" OR "dumpster fire"`,
  `"${brand}" bullshit OR bs`,
  `"${brand} is mid" OR "${brand} is overrated"`,
  `"${brand}" "waste of time"`,
];

const GRIPE = /suck|trash|garbage|awful|terrible|hate|worst|stupid|annoying|ruin|frustrat|clunky|unusable|confus|why is|why does|gave up|hot mess|nightmare|painful|crap|junk|rubbish|joke|mess|bullshit|\bbs\b|overrated|waste|froze|frozen|crash|hang|hung|lost|deleted/i;

for (const q of candidates) {
  try {
    const hits = await braveSearch(q, 10);
    const g = hits.filter((h) => GRIPE.test(`${h.title} ${h.description}`));
    console.log(`${String(hits.length).padStart(2)} hits ${String(g.length).padStart(2)} gripey  ${q.slice(0, 58)}`);
    if (g[0]) console.log(`                      e.g. ${g[0].title.slice(0, 84)}`);
  } catch { console.log(` FAILED                ${q.slice(0, 58)}`); }
}
