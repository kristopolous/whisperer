import { randomUUID } from 'node:crypto';
import { diagnoseIssue } from '../app/server/agents/diagnose-run.ts';
import { fixIssue } from '../app/server/agents/fix-run.ts';
import type { Issue, Mention, Scan } from '../app/shared/types.ts';

const log = (l: 'info' | 'warn', t: string) => console.log(`  [${l}] ${t}`);
const mid = randomUUID().slice(0, 8);
const scan = {
  id: 'fix-only', company: 'hangman-test', site: 'https://github.com/kristopolous/hangman-test',
  mentions: [{
    id: mid, venue: 'reddit', title: 'this hangman game sucks',
    url: 'https://reddit.com/example', date: new Date().toISOString(), author: null,
    excerpt: "this hangman game sucks! you can't guess the letter q",
    engagement: null, sentiment: 'negative', score: -0.7, themes: [], scored: true,
  } as Mention],
} as unknown as Scan;

const issue = {
  id: 'i1', title: 'Letter q cannot be guessed', kind: 'bug', severity: 'serious',
  summary: 'The letter q cannot be entered as a guess.',
  impact: 'Words containing q are unwinnable.',
  evidence: [mid], firstSeen: null, lastSeen: null, draftReply: '', status: 'open',
} as unknown as Issue;

const d = await diagnoseIssue(scan, issue, 'data/repos/hangman-test', log);
console.log(`diagnosis: ${d.verdict}\n`);
const fix = await fixIssue(scan, issue, d, 'data/repos/hangman-test', log);
console.log(`\napplied: ${fix.applied} | tests: ${fix.tests.passed ? 'PASS' : 'FAIL'} | proves the bug: ${fix.provesTheBug.failedOnOriginal}`);
console.log(`summary: ${fix.summary}`);
console.log(`\n--- diff ---\n${fix.diff.slice(0, 2500)}`);
