/** Unit checks for the entity decoder. Run: npx tsx scripts/entity-check.ts */
import { cleanText, decodeEntities } from '../app/shared/html.ts';

const cases: [string, string][] = [
  ["GIMP 3.2 landed in March 2026 and it&#x27;s actually a strong release",
   "GIMP 3.2 landed in March 2026 and it's actually a strong release"],
  ["Tom &amp; Jerry", "Tom & Jerry"],
  ["a &quot;quoted&quot; thing", 'a "quoted" thing'],
  ["caf&eacute; &mdash; open", "café — open"],
  ["&#39;single&#39;", "'single'"],
  ["5 &lt; 10 &gt; 2", "5 < 10 > 2"],
  ["already decoded, it's fine", "already decoded, it's fine"],
  ["&notreal; stays", "&notreal; stays"],
  ["&#x110000; out of range", "&#x110000; out of range"],
  ["&amp;#x27; stays escaped once", "&#x27; stays escaped once"],
];

let failed = 0;
for (const [input, want] of cases) {
  const got = decodeEntities(input);
  const ok = got === want;
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${JSON.stringify(input).slice(0, 52).padEnd(54)} -> ${JSON.stringify(got)}`);
}

console.log(`\ncleanText strips tags too:`);
console.log(`  ${JSON.stringify(cleanText('<strong>GIMP</strong> is  free &amp;  open'))}`);
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
