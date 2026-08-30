/** A real reported defect, diagnosed against a real checkout.
 *  Run: npx tsx --env-file=.env scripts/diagnose-check.ts */
import { randomUUID } from 'node:crypto';
import { diagnoseIssue } from '../app/server/agents/diagnose-run.ts';
import type { Issue, Scan } from '../app/shared/types.ts';

const mentionId = randomUUID().slice(0, 8);

const scan = {
  id: 'diag-demo',
  company: 'GIMP',
  site: 'https://www.gimp.org',
  mentions: [{
    id: mentionId,
    venue: 'github' as const,
    title: 'gimp3: Crashes when choosing Legacy Icons in Preferences',
    url: 'https://gitlab.gnome.org/GNOME/gimp/-/issues/example',
    date: new Date(Date.now() - 410 * 86400000).toISOString(),
    author: null,
    excerpt: 'GIMP 3 crashes immediately when I open Preferences, go to Interface > Icon Theme and select the Legacy icon theme. It closes with no error dialog. Symbolic and Color themes switch fine.',
    engagement: null,
    sentiment: 'negative' as const,
    score: -0.8,
    themes: ['crashes', 'icon themes'],
  }],
} as unknown as Scan;

const issue = {
  id: 'iss-demo',
  title: 'Crash when selecting the Legacy icon theme in Preferences',
  kind: 'bug' as const,
  severity: 'critical' as const,
  summary: 'Selecting the Legacy icon theme under Preferences > Interface terminates the application immediately.',
  impact: 'Users cannot switch to the Legacy icon theme; the application exits without saving.',
  evidence: [mentionId],
  firstSeen: null,
  lastSeen: null,
  draftReply: '',
  status: 'open' as const,
} as unknown as Issue;

const started = Date.now();
const d = await diagnoseIssue(scan, issue, 'data/repos/gimp', (l, t) => console.log(`  [${l}] ${t}`));

console.log(`\n=== DIAGNOSIS in ${Math.round((Date.now() - started) / 1000)}s ===`);
console.log(`verdict:    ${d.verdict}  (confidence ${d.confidence})`);
console.log(`reasoning:  ${d.reasoning}`);
console.log(`cause:      ${d.likelyCause}`);
console.log(`fix:        ${d.proposedFix}`);
console.log(`test:       ${d.regressionTest}`);
console.log(`\nsuspect files:`);
for (const f of d.suspectFiles) console.log(`  ${f.path}\n     ${f.why}`);
console.log(`\nunknowns:`);
for (const u of d.unknowns) console.log(`  - ${u}`);
console.log(`\nsearched ${d.searched.terms.length} terms, ${d.searched.hits} hits across ${d.searched.files.length} files`);
