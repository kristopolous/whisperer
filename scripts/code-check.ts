/** Does the deterministic code search land anywhere useful?
 *  Run: npx tsx scripts/code-check.ts "<bug report text>" */
import { findRelevantCode, rankFiles, termsFromIssue } from '../app/server/code.ts';

const report = process.argv[2] ?? 'gimp3: Crashes when choosing "Legacy Icons" in Preferences dialog';
const repo = 'data/repos/gimp';

console.log(`report: ${report}\n`);
console.log('terms:', termsFromIssue(report).join(' | '), '\n');

const started = Date.now();
const { hits } = await findRelevantCode(repo, report);
console.log(`${hits.length} matching lines in ${Date.now() - started}ms\n`);

for (const f of rankFiles(hits, 8)) {
  console.log(`  ${String(f.terms.length).padStart(2)} terms, ${String(f.matches).padStart(3)} matches  ${f.file}`);
  console.log(`      ${f.terms.slice(0, 5).join(', ')}`);
}
