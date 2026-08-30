/** What does the resolve agent make of various inputs?
 *  Run: npx tsx --env-file=.env scripts/resolve-check.ts [input...] */
import { resolveSubject } from '../app/server/agents/resolve-run.ts';

const inputs = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['https://github.com/unclecode/crawl4ai', 'gimp image editor', 'bolt.new'];

for (const input of inputs) {
  console.log(`\n=== ${input}`);
  const s = await resolveSubject(input, (l, t) => console.log(`  [${l}] ${t}`));
  console.log(`  name:       ${s.name}`);
  console.log(`  search:     "${s.searchTerm}"${s.aliases.length ? `  aliases: ${s.aliases.join(', ')}` : ''}`);
  console.log(`  not:        ${s.excludeTerms.join(', ') || '(nothing ambiguous)'}`);
  console.log(`  site:       ${s.site || '—'}`);
  console.log(`  repo:       ${s.repo || '—'}`);
  console.log(`  kind:       ${s.kind} (${s.confidence})`);
  console.log(`  summary:    ${s.summary.slice(0, 120)}`);
}
