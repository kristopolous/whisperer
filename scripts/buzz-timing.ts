/** Where does the time go: the model, or compiling the JSON-schema grammar? */
import { readFileSync } from 'node:fs';
import { buzzAgent } from '../app/server/agents/buzz.ts';
import { resolveEndpoint } from '../app/server/model.ts';
import type { Scan } from '../app/shared/types.ts';

const scans = JSON.parse(readFileSync('data/scans.json', 'utf8')) as Scan[];
const scan = scans.find((s) => s.id === 'c6499e8f')!;
const corpus = scan.mentions.slice(0, 4).map((m) => ({
  url: m.url, title: m.title, text: m.excerpt.slice(0, 900),
}));
const e = resolveEndpoint();

async function trial(label: string, body: Record<string, unknown>, ms: number) {
  const started = Date.now();
  try {
    const res = await fetch(`${e.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: e.modelId, stream: false, ...body }),
      signal: AbortSignal.timeout(ms),
    });
    const text = await res.text();
    const out = (JSON.parse(text).choices?.[0]?.message?.content ?? '').slice(0, 90);
    console.log(`${label.padEnd(34)} ${res.status}  ${Math.round((Date.now() - started) / 1000)}s  ${JSON.stringify(out)}`);
  } catch (err) {
    console.log(`${label.padEnd(34)} —    ${Math.round((Date.now() - started) / 1000)}s  ${err instanceof Error ? err.message : err}`);
  }
}

const messages = [
  { role: 'system', content: buzzAgent.instructions },
  { role: 'user', content: `Product: "replit". Score every item.\n\n${JSON.stringify(corpus)}` },
];

await trial('tiny prompt, no schema', { messages: [{ role: 'user', content: 'Say ok.' }], max_tokens: 10 }, 60_000);
await trial('real prompt, NO schema', { messages, max_tokens: 300 }, 120_000);
await trial('real prompt, WITH buzz schema', {
  messages,
  response_format: { type: 'json_schema', json_schema: { name: buzzAgent.schema.name, schema: buzzAgent.schema.schema, strict: true } },
}, 150_000);
