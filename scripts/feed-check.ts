/** What the feed will actually lead with, and how fresh it is.
 *  Run: npx tsx --env-file=.env scripts/feed-check.ts [company] [site] */
import { findFeed } from '../app/server/pipeline.ts';

const company = process.argv[2] ?? 'replit';
const site = process.argv[3] ?? `https://${company}.com`;

const started = Date.now();
const items = await findFeed(company, site, [], (l, t) => console.log(`[${l}] ${t}`));
const hours = (iso: string | null) => (iso ? Math.round((Date.now() - Date.parse(iso)) / 3_600_000) : null);

console.log(`\n${items.length} items in ${Math.round((Date.now() - started) / 1000)}s\n`);
for (const item of items.slice(0, 12)) {
  const h = hours(item.date);
  console.log(`  ${(h == null ? '—' : h < 48 ? `${h}h` : `${Math.round(h / 24)}d`).padStart(5)}  ${item.venue.padEnd(10)} ${item.headline.slice(0, 54)}`);
}
const ages = items.map((i) => hours(i.date)).filter((n): n is number => n != null);
console.log(`\nwithin 24h: ${ages.filter((h) => h <= 24).length}  within 48h: ${ages.filter((h) => h <= 48).length}  within 7d: ${ages.filter((h) => h <= 168).length}  of ${items.length}`);
