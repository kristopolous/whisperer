/** The whole product in one script: real public complaints in, engineering
 *  issues out. Run: npx tsx --env-file=.env scripts/gripe-check.ts [company] [n]
 *
 *  Buzz is stubbed rather than run — the mentions are pre-scored negative so
 *  triage has something to rank by. That is honest for this purpose: the
 *  question is whether the triage agent can turn somebody's gripe into a filed
 *  defect, and scoring is already known to work.
 */
import { readFileSync } from 'node:fs';
import { findIssues } from '../app/server/pipeline.ts';
import type { Mention, Scan } from '../app/shared/types.ts';

const company = process.argv[2] ?? 'replit';
const want = Number(process.argv[3] ?? 8);

const scans = JSON.parse(readFileSync('data/scans.json', 'utf8')) as Scan[];
const scan = scans.filter((s) => s.company === company).sort((a, b) => b.mentions.length - a.mentions.length)[0];
if (!scan) throw new Error(`no scan for ${company}`);

const COMPLAINT = /broken|not working|doesn'?t work|crash|bug|error|fail|slow|frustrat|unusable|useless|scam|charged|refund|billing|deleted|terrible|awful|worst|disappoint|stuck|confus|clunky|hard to use/i;

const complaints: Mention[] = scan.mentions
  .filter((m) => COMPLAINT.test(`${m.title} ${m.excerpt}`))
  .slice(0, want)
  .map((m) => ({ ...m, score: -0.6, sentiment: 'negative' as const }));

console.log(`${scan.mentions.length} mentions stored; ${complaints.length} fed to triage:\n`);
for (const m of complaints) console.log(`  [${m.venue}] ${m.title.slice(0, 72)}`);

const started = Date.now();
const issues = await findIssues(company, complaints, (level, text) => console.log(`  [${level}] ${text}`));

console.log(`\n=== ${issues.length} ISSUE(S) in ${Math.round((Date.now() - started) / 1000)}s ===\n`);
for (const issue of issues) {
  console.log(`## [${issue.severity}/${issue.kind}] ${issue.title}`);
  console.log(`   ${issue.summary}`);
  console.log(`   impact: ${issue.impact}`);
  console.log(`   evidence: ${issue.evidence.length} mention(s)\n`);
}
