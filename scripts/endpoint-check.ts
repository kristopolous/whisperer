/** Is the configured inference endpoint actually usable?
 *  Run: npx tsx --env-file=.env scripts/endpoint-check.ts */
import { resolveEndpoint } from '../app/server/model.ts';

const e = resolveEndpoint();
console.log(`baseUrl: ${e.baseUrl}`);
console.log(`model:   ${e.modelId}`);
console.log(`key:     ${e.apiKey ? 'present' : 'MISSING'}\n`);

const started = Date.now();
try {
  const r = await fetch(`${e.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(e.apiKey ? { Authorization: `Bearer ${e.apiKey}` } : {}) },
    body: JSON.stringify({ model: e.modelId, messages: [{ role: 'user', content: 'Say ok.' }], max_tokens: 10, stream: false }),
    signal: AbortSignal.timeout(90_000),
  });
  const text = await r.text();
  console.log(`HTTP ${r.status} in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(text.slice(0, 300).replace(/\s+/g, ' '));
} catch (err) {
  console.log(`failed in ${Math.round((Date.now() - started) / 1000)}s: ${err instanceof Error ? err.message : err}`);
}
