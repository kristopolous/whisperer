/** Decode HTML entities in already-stored scans.
 *
 *  The ingestion path decodes now, but scans collected before that still hold
 *  text like `it&#x27;s actually a strong release`. This rewrites them in place.
 *
 *  Only fields that came from search are touched — titles, excerpts, headlines
 *  and snippets. Model-written prose (issue summaries, draft replies) is left
 *  alone: it was never HTML, and the whitespace collapsing that cleaning
 *  applies would run its paragraphs together.
 *
 *  Run the API down. The server keeps scans in memory and rewrites the file on
 *  its next save, so a migration applied underneath a running process is lost.
 *
 *    npx tsx scripts/fix-escaping.ts          # report only
 *    npx tsx scripts/fix-escaping.ts --write  # apply, after taking a backup
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { decodeEntities } from '../app/shared/html.ts';
import type { Scan } from '../app/shared/types.ts';

const FILE = 'data/scans.json';
const write = process.argv.includes('--write');

const scans = JSON.parse(readFileSync(FILE, 'utf8')) as Scan[];
const changes: { scan: string; field: string; before: string; after: string }[] = [];

const fix = <T extends Record<string, unknown>>(row: T, field: keyof T & string, scanId: string) => {
  const before = row[field];
  if (typeof before !== 'string') return;
  const after = decodeEntities(before);
  if (after !== before) {
    changes.push({ scan: scanId, field, before, after });
    (row as Record<string, unknown>)[field] = after;
  }
};

for (const scan of scans) {
  for (const mention of scan.mentions ?? []) {
    fix(mention, 'title', scan.id);
    fix(mention, 'excerpt', scan.id);
  }
  for (const item of scan.feed ?? []) {
    fix(item, 'headline', scan.id);
    fix(item, 'snippet', scan.id);
  }
  for (const profile of scan.profiles ?? []) {
    fix(profile as unknown as Record<string, unknown>, 'handle', scan.id);
  }
}

console.log(`${changes.length} field(s) would change across ${new Set(changes.map((c) => c.scan)).size} scan(s)`);
for (const change of changes.slice(0, 5)) {
  console.log(`\n  ${change.scan} · ${change.field}`);
  console.log(`    before: ${change.before.slice(0, 96)}`);
  console.log(`    after:  ${change.after.slice(0, 96)}`);
}

if (!write) {
  console.log('\nreport only — pass --write to apply (a .bak copy is taken first)');
} else if (changes.length) {
  const backup = `${FILE}.bak-${Date.now()}`;
  copyFileSync(FILE, backup);
  writeFileSync(FILE, JSON.stringify(scans, null, 2));
  console.log(`\napplied. backup at ${backup}`);
}
