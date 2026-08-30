/** Discovery -> triage, for real. Buzz is stubbed (complaint-flagged mentions
 *  scored negative) so triage has a ranking to work from.
 *  Run: npx tsx --env-file=.env scripts/end-to-end.ts [company] [site] */
import { findIssues, findMentions } from '../app/server/pipeline.ts';

const company = process.argv[2] ?? 'gimp';
const site = process.argv[3] ?? `https://www.${company}.org`;

const mentions = await findMentions(company, site, [], () => {});
const complaints = mentions
  .filter((m) => m.complaint)
  .slice(0, 8)
  .map((m) => ({ ...m, score: -0.6, sentiment: 'negative' as const }));

console.log(`${mentions.length} mentions, ${mentions.filter((m) => m.complaint).length} complaint-bearing`);
console.log(`feeding ${complaints.length} to triage:\n`);
for (const m of complaints) console.log(`  [${m.venue}] ${m.title.slice(0, 74)}`);

const started = Date.now();
const issues = await findIssues(company, complaints, (l, t) => console.log(`  [${l}] ${t}`));

console.log(`\n=== ${issues.length} ISSUE(S) in ${Math.round((Date.now() - started) / 1000)}s ===\n`);
for (const i of issues) {
  console.log(`## [${i.severity}/${i.kind}] ${i.title}`);
  console.log(`   ${i.summary}`);
  console.log(`   impact: ${i.impact}`);
  console.log(`   evidence: ${i.evidence.length}\n`);
}
