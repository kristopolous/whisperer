import { braveSearch } from '../app/server/search.ts';
const brand = process.argv[2] ?? 'gimp';

const candidates = [
  `"${brand} isn't" OR "${brand} is not" recommend OR ideal OR great`,
  `"wouldn't recommend ${brand}" OR "can't recommend ${brand}"`,
  `"${brand} won't work" OR "${brand} doesn't suit"`,
  `"not a fan of ${brand}"`,
  `"${brand} falls short" OR "${brand} lacks"`,
  `"instead of ${brand}" better OR easier`,
  `"${brand} isn't for everyone" OR "${brand} isn't for you"`,
  `"struggled with ${brand}" OR "struggling with ${brand}"`,
  `"${brand} has a steep learning curve"`,
  `"wish ${brand}" would OR could OR had`,
  `"${brand} needs" better OR fixing OR improvement`,
  `"disappointed" ${brand}`,
];

const GRIPE = /suck|trash|garbage|awful|terrible|hate|worst|stupid|annoying|ruin|frustrat|clunky|unusable|confus|why is|why does|gave up|hot mess|nightmare|painful|isn't|is not|wouldn't|won't|lacks|falls short|struggl|steep|wish|needs|disappoint|not a fan|instead of/i;

for (const q of candidates) {
  try {
    const hits = await braveSearch(q, 10);
    const g = hits.filter((h) => GRIPE.test(`${h.title} ${h.description}`));
    console.log(`${String(hits.length).padStart(2)} hits ${String(g.length).padStart(2)} gripey  ${q.slice(0, 62)}`);
    if (g[0]) console.log(`                      e.g. ${g[0].title.slice(0, 84)}`);
  } catch (e) {
    console.log(` FAILED                ${q.slice(0, 62)}`);
  }
}
