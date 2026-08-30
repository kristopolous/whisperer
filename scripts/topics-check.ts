/** Topic timeline checks.
 *
 *  Default is the fast path: mechanical merge, plus a stubbed grouping that
 *  exercises the same code the topics agent feeds, with no model call. Pass
 *  --live to actually fire the agent.
 *
 *  Run: npx tsx --env-file=.env scripts/topics-check.ts [scanId] [--live]
 */
import { readFileSync } from 'node:fs';
import { buildTopics, groupTopics } from '../app/server/pipeline.ts';
import type { Scan, TopicPoint } from '../app/shared/types.ts';

const args = process.argv.slice(2);
const live = args.includes('--live');
const wanted = args.find((a) => !a.startsWith('--'));

const scans = JSON.parse(readFileSync('data/scans.json', 'utf8')) as Scan[];
const scan = wanted
  ? scans.find((s) => s.id === wanted)
  : scans.filter((s) => (s.mentions ?? []).some((m) => (m.themes ?? []).length))
      .sort((a, b) => b.mentions.length - a.mentions.length)[0];
if (!scan) throw new Error('no scan with themed mentions');

function show(title: string, topics: TopicPoint[]) {
  const bands = new Set(topics.flatMap((p) => Object.keys(p.byTopic)));
  const other = topics.reduce((sum, p) => sum + (p.byTopic['other topics'] ?? 0), 0);
  const total = topics.reduce((sum, p) => sum + Object.values(p.byTopic).reduce((a, b) => a + b, 0), 0);
  console.log(`\n--- ${title} ---`);
  console.log(`${bands.size} bands · ${topics.length} months · ${total} placements, ${other} unattributed (${total ? Math.round((other / total) * 100) : 0}%)`);
  console.log(`bands: ${[...bands].join(', ')}`);
}

const dated = scan.mentions.filter((m) => m.date && (m.themes ?? []).length);
console.log(`scan ${scan.id} · ${scan.company} · ${scan.mentions.length} mentions, ${dated.length} dated and themed`);

show('mechanical merge only', buildTopics(scan.mentions));

/** A stand-in for what the agent returns: bucket every theme by the first
 *  significant word it shares with a common subject. Crude on purpose — the
 *  point is to prove the grouping is applied and counted, not to be good. */
const SUBJECTS = ['pricing', 'credit', 'reliability', 'auth', 'database', 'deploy', 'export', 'support'];
const stub = new Map<string, string>();
for (const theme of new Set(dated.flatMap((m) => m.themes ?? []))) {
  const hit = SUBJECTS.find((s) => theme.toLowerCase().includes(s));
  if (hit) stub.set(theme.trim(), hit);
}
console.log(`\nstub grouping maps ${stub.size} themes onto ${new Set(stub.values()).size} subjects`);
show('with a stubbed grouping', buildTopics(scan.mentions, { grouping: stub }));

if (live) {
  const started = Date.now();
  const topics = await groupTopics(scan.company, scan.mentions, (l, t) => console.log(`  [${l}] ${t}`));
  show(`with the topics agent (${Math.round((Date.now() - started) / 1000)}s)`, topics);
}
