/** The whole product, on a real repository we own.
 *
 *  Public gripe -> triaged issue -> filed ticket -> diagnosis against the real
 *  source -> patch verified by the test suite -> pull request on our own repo.
 *
 *  Run: npx tsx --env-file=.env scripts/full-loop.ts
 */
import { randomUUID } from 'node:crypto';
import { diagnoseIssue } from '../app/server/agents/diagnose-run.ts';
import { fileTicket, submitTicket } from '../app/server/agents/file-ticket.ts';
import { fixIssue } from '../app/server/agents/fix-run.ts';
import { openPullRequest } from '../app/server/channels/github.ts';
import { findIssues } from '../app/server/pipeline.ts';
import type { Mention, Scan } from '../app/shared/types.ts';

const REPO = 'data/repos/hangman-test';
const log = (l: 'info' | 'warn', t: string) => console.log(`  [${l}] ${t}`);

const gripe: Mention = {
  id: randomUUID().slice(0, 8),
  venue: 'reddit',
  title: 'this hangman game sucks',
  url: 'https://www.reddit.com/r/commandline/comments/example/this_hangman_game_sucks/',
  date: new Date(Date.now() - 2 * 86400000).toISOString(),
  author: 'a_stranger',
  excerpt: "this hangman game sucks! you can't guess the letter q",
  engagement: null,
  sentiment: 'negative', score: -0.7, themes: ['input handling'],
  discussion: true, complaint: true, scored: true,
};

const scan = {
  id: 'full-loop', company: 'hangman-test',
  site: 'https://github.com/kristopolous/hangman-test',
  mentions: [gripe], issues: [],
} as unknown as Scan;

console.log(`GRIPE  "${gripe.excerpt}"\n`);

const issues = await findIssues('hangman-test', [gripe], log);
if (!issues.length) { console.log('triage found nothing'); process.exit(1); }
scan.issues = issues;
const issue = issues[0]!;
console.log(`\nISSUE  [${issue.severity}/${issue.kind}] ${issue.title}\n`);

console.log('FILING');
const draft = await fileTicket(scan, issue, 'github');
const filed = await submitTicket(draft, scan, issue);
console.log(`  ${filed.filed ? `filed ${filed.ref} — ${filed.url}` : `not filed: ${filed.reason}`}\n`);
if (filed.filed) {
  issue.filedTo = { tracker: 'github', ref: filed.ref!, at: new Date().toISOString() };
  issue.status = 'filed';
}

console.log('DIAGNOSING');
const diagnosis = await diagnoseIssue(scan, issue, REPO, log);
issue.diagnosis = { ...diagnosis, at: new Date().toISOString() };
console.log(`  ${diagnosis.verdict} (${diagnosis.confidence}) — ${diagnosis.likelyCause.slice(0, 130)}\n`);

console.log('FIXING');
const fix = await fixIssue(scan, issue, diagnosis, REPO, log);
issue.fix = { ...fix, at: new Date().toISOString() };
console.log(`  tests: ${fix.tests.passed ? 'PASS' : 'FAIL'} | proves the bug: ${fix.provesTheBug.failedOnOriginal}\n`);

if (fix.applied && fix.tests.passed) {
  console.log('OPENING PULL REQUEST');
  const pr = await openPullRequest(
    fix.files.map((f) => ({ path: f.path, contents: f.contents })),
    issue.title,
    `${fix.summary}\n\nReported publicly: ${issue.summary}\n\nTests: \`${fix.tests.command}\` — pass.\nRegression test vs original code: ${fix.provesTheBug.detail}`,
    log,
  );
  console.log(`\n  PR #${pr.number}: ${pr.url}`);
} else {
  console.log('not opening a pull request — the fix did not verify');
}
