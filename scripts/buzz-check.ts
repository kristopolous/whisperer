/** One buzz batch against real stored mentions, with the real error.
 *  Run: npx tsx --env-file=.env scripts/buzz-check.ts [n] */
import { readFileSync } from 'node:fs';
import { buzzAgent } from '../app/server/agents/buzz.ts';
import { runAgent } from '../app/server/agents/runtime.ts';
import { resolveEndpoint } from '../app/server/model.ts';
import type { Scan } from '../app/shared/types.ts';

const n = Number(process.argv[2] ?? 4);
const scans = JSON.parse(readFileSync('data/scans.json', 'utf8')) as Scan[];
const scan = scans.find((s) => s.id === 'c6499e8f')!;

const endpoint = resolveEndpoint();
console.log(`endpoint: ${endpoint.baseUrl}  model: ${endpoint.modelId}`);
console.log(`context: ${endpoint.contextLength}  maxOut: ${endpoint.maxOutputTokens}\n`);

const corpus = scan.mentions.slice(0, n).map((m) => ({
  url: m.url, date: m.date, venue: m.venue, title: m.title, text: m.excerpt.slice(0, 900),
}));
const prompt = `Product: "${scan.company}". Score every item and write the verdict.\n\n${JSON.stringify(corpus)}`;
console.log(`prompt: ${prompt.length} chars (~${Math.round(prompt.length / 4)} tokens), ${corpus.length} items\n`);

const started = Date.now();
try {
  const r = await runAgent<{ scored: unknown[]; verdict: string }>(buzzAgent, { prompt, items: corpus.length, timeoutMs: 300_000 });
  console.log(`OK in ${Math.round((Date.now() - started) / 1000)}s — ${r.scored?.length ?? 0} scored`);
  console.log(JSON.stringify(r.scored?.slice(0, 2), null, 1));
} catch (e) {
  console.log(`FAILED in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(e instanceof Error ? e.message : String(e));
}
