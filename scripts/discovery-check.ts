/** Run the real discovery search and show what the dashboard will lead with.
 *  Run: npx tsx --env-file=.env scripts/discovery-check.ts [company] [site] */
import { findMentions } from '../app/server/pipeline.ts';

const company = process.argv[2] ?? 'replit';
const site = process.argv[3] ?? `https://${company}.com`;

const started = Date.now();
const mentions = await findMentions(company, site, [], (l, t) => console.log(`[${l}] ${t}`));
const days = (iso: string | null) => (iso ? Math.round((Date.now() - Date.parse(iso)) / 86_400_000) : null);

const sorted = [...mentions].sort((a, b) => {
  const c = Number(b.complaint ?? false) - Number(a.complaint ?? false);
  if (c !== 0) return c;
  const d = Number(b.discussion ?? true) - Number(a.discussion ?? true);
  if (d !== 0) return d;
  if (Boolean(a.date) !== Boolean(b.date)) return a.date ? -1 : 1;
  return (b.date ?? '').localeCompare(a.date ?? '');
});

console.log(`\n${mentions.length} mentions in ${Math.round((Date.now() - started) / 1000)}s\n`);
console.log('TOP 8 as the dashboard will show them:');
for (const m of sorted.slice(0, 8)) {
  console.log(`  ${String(days(m.date) ?? '—').padStart(5)}d ${m.complaint ? '!' : ' '} ${m.venue.padEnd(10)} ${m.title.slice(0, 54)}`);
}
const ages = sorted.slice(0, 10).map((m) => days(m.date)).filter((n): n is number => n != null).sort((a, b) => a - b);
console.log(`\nmedian age of first 10: ${ages[Math.floor(ages.length / 2)]}d`);
console.log(`within 90 days: ${mentions.filter((m) => m.date && days(m.date)! <= 90).length}/${mentions.length}`);
