/** Does the brand matcher admit the right things and reject look-alikes?
 *  Run: npx tsx scripts/brand-match-check.ts */
import { namesCompany } from '../app/server/search.ts';

const hit = (title: string, description = '', url = 'https://example.com/x') =>
  ({ title, description, url, age: null, date: null });

const cases: [string, ReturnType<typeof hit>, boolean][] = [
  // should MATCH
  ['bolt', hit('Bolt is the fastest way to build an app'), true],
  ['bolt', hit('I tried Bolt.new for a week'), true],
  ['bolt', hit('review', '', 'https://reddit.com/r/bolt/comments/1'), true],
  ['bolt', hit("Bolt's pricing is confusing"), true],
  ['gimp', hit('GIMP 3.2 is out'), true],
  ['next.js', hit('nextjs app router is confusing'), true],
  // What a person actually types is "Hacker News"; the squashed path above is
  // for brands that carry punctuation, like next.js.
  ['Hacker News', hit('Seen on Hacker News today'), true],

  // should NOT match
  ['bolt', hit('Boltt Evo, Boltt Ace 5G Software Update Policy Confirmed'), false],
  ['bolt', hit('Usain Bolts record still stands'), false],
  ['bolt', hit('I bolted the frame together'), false],
  ['bolt', hit('Thunderbolt 4 docks compared'), false],
  ['gimp', hit('The gimpy old dog limped home'), false],
];

let failed = 0;
for (const [company, h, want] of cases) {
  const got = namesCompany(h, company);
  const ok = got === want;
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${company.padEnd(11)} ${want ? 'match ' : 'reject'}  ${h.title.slice(0, 56)}`);
}
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
