/** One real, recent, public complaint -> one engineering issue. End to end.
 *  Run: npx tsx --env-file=.env scripts/gripe-to-issue.ts [query] [company] */
import { randomUUID } from 'node:crypto';
import { findIssues } from '../app/server/pipeline.ts';
import { braveSearch } from '../app/server/search.ts';
import type { Mention } from '../app/shared/types.ts';

const query = process.argv[2] ?? 'site:reddit.com "so frustrating"';
const company = process.argv[3] ?? 'Outlook';

const hits = (await braveSearch(query, 10, 'pw')).filter((h) => h.date);
if (hits.length === 0) throw new Error('no dated hits');

const mentions: Mention[] = hits.slice(0, 4).map((h) => ({
  id: randomUUID().slice(0, 8),
  venue: 'reddit',
  title: h.title,
  url: h.url,
  date: h.date,
  author: null,
  excerpt: h.description,
  engagement: null,
  sentiment: 'negative',
  score: -0.6,
  themes: [],
  discussion: true,
}));

console.log(`Feeding ${mentions.length} real complaints to triage:\n`);
for (const m of mentions) {
  console.log(`  ${m.date!.slice(0, 10)}  ${m.title.slice(0, 70)}`);
  console.log(`             "${m.excerpt.replace(/\s+/g, ' ').slice(0, 120)}"`);
  console.log(`             ${m.url}\n`);
}

const started = Date.now();
const issues = await findIssues(company, mentions, (l, t) => console.log(`  [${l}] ${t}`));

console.log(`\n=== ${issues.length} ISSUE(S) in ${Math.round((Date.now() - started) / 1000)}s ===\n`);
for (const i of issues) {
  console.log(`## [${i.severity}/${i.kind}] ${i.title}`);
  console.log(`   summary: ${i.summary}`);
  console.log(`   impact:  ${i.impact}`);
  console.log(`   reply:   ${(i.draftReply ?? '').slice(0, 200)}`);
  console.log(`   evidence: ${i.evidence.length}, first seen ${i.firstSeen ?? '—'}\n`);
}
