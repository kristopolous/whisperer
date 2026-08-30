/** The whole thesis, end to end, on a repo with a known planted bug.
 *
 *  A public gripe -> triaged issue -> diagnosis against the actual source.
 *  Run: npx tsx --env-file=.env scripts/hangman-demo.ts */
import { randomUUID } from 'node:crypto';
import { diagnoseIssue } from '../app/server/agents/diagnose-run.ts';
import { fixIssue } from '../app/server/agents/fix-run.ts';
import { findIssues } from '../app/server/pipeline.ts';
import type { Mention, Scan } from '../app/shared/types.ts';

const REPO = 'data/repos/hangman-test';

// 1. The gripe, exactly as a person would leave it.
const gripe: Mention = {
  id: randomUUID().slice(0, 8),
  venue: 'reddit',
  title: 'this hangman game sucks',
  url: 'https://www.reddit.com/r/commandline/comments/example/this_hangman_game_sucks/',
  date: new Date(Date.now() - 2 * 86400000).toISOString(),
  author: null,
  excerpt: "this hangman game sucks! you can't guess the letter q",
  engagement: null,
  // Buzz is stubbed: the mention is pre-scored so triage has a ranking.
  sentiment: 'negative',
  score: -0.7,
  themes: ['input handling'],
  discussion: true,
  complaint: true,
};

const scan = {
  id: 'hangman-demo',
  company: 'hangman-test',
  site: 'https://github.com/kristopolous/hangman-test',
  mentions: [gripe],
} as unknown as Scan;

console.log(`GRIPE  [${gripe.venue}] ${gripe.excerpt}\n`);

// 2. Triage it into an engineering issue.
const issues = await findIssues('hangman-test', [gripe], (l, t) => console.log(`  [${l}] ${t}`));
if (issues.length === 0) {
  console.log('\ntriage produced no issue — stopping here');
  process.exit(1);
}
scan.issues = issues;

const issue = issues[0]!;
console.log(`\nISSUE  [${issue.severity}/${issue.kind}] ${issue.title}`);
console.log(`       ${issue.summary}`);
console.log(`       impact: ${issue.impact}\n`);

// 3. Send it into the source.
const started = Date.now();
const d = await diagnoseIssue(scan, issue, REPO, (l, t) => console.log(`  [${l}] ${t}`));

console.log(`\nDIAGNOSIS in ${Math.round((Date.now() - started) / 1000)}s`);
console.log(`  verdict:  ${d.verdict} (${d.confidence})`);
console.log(`  cause:    ${d.likelyCause}`);
console.log(`  fix:      ${d.proposedFix}`);
console.log(`  test:     ${d.regressionTest}`);
console.log(`  files:`);
for (const f of d.suspectFiles) console.log(`    ${f.path} — ${f.why.slice(0, 120)}`);
if (d.unknowns.length) console.log(`  unknowns: ${d.unknowns.join('; ').slice(0, 200)}`);

// 4. Fix it, in a throwaway copy, and only believe the tests.
console.log('\nFIXING');
const fixStarted = Date.now();
const fix = await fixIssue(scan, issue, d, REPO, (l, t) => console.log(`  [${l}] ${t}`));

console.log(`\nFIX in ${Math.round((Date.now() - fixStarted) / 1000)}s`);
console.log(`  applied:  ${fix.applied}   attempts: ${fix.attempts}`);
console.log(`  summary:  ${fix.summary}`);
console.log(`  tests:    ${fix.tests.command} -> ${fix.tests.passed ? 'PASS' : 'FAIL'}`);
console.log(`  proves the bug: ${fix.provesTheBug.detail}`);
if (fix.notes) console.log(`  notes:    ${fix.notes.slice(0, 300)}`);
console.log(`\n--- diff ---\n${fix.diff.slice(0, 4000)}`);
