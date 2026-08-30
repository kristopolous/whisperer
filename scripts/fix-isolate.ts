import { fixAgent } from '../app/server/agents/fix.ts';
import { askJsonDirect } from '../app/server/model.ts';
import { diagnoseSchema, fixSchema } from '../app/server/schemas.ts';

const tiny = 'Product: "hangman". Fix: QUIT_KEY = "q" collides with guessing q. File hangman.py contains: QUIT_KEY = "q"';

const trials: [string, Parameters<typeof askJsonDirect>[0]][] = [
  ['fix schema + fix instructions', { instructions: fixAgent.instructions, prompt: tiny, schema: fixSchema, role: 'coding', timeoutMs: 120_000 }],
  ['fix schema + short instructions', { instructions: 'You fix bugs. Return edits.', prompt: tiny, schema: fixSchema, role: 'coding', timeoutMs: 120_000 }],
  ['simple schema + fix instructions', { instructions: fixAgent.instructions, prompt: tiny, schema: diagnoseSchema, role: 'coding', timeoutMs: 120_000 }],
];

for (const [label, opts] of trials) {
  const t = Date.now();
  try {
    const r = await askJsonDirect<Record<string, unknown>>(opts);
    console.log(`ok    ${label.padEnd(34)} ${Math.round((Date.now() - t) / 1000)}s  keys: ${Object.keys(r).join(',')}`);
  } catch (e) {
    console.log(`FAIL  ${label.padEnd(34)} ${Math.round((Date.now() - t) / 1000)}s  ${e instanceof Error ? e.message.slice(0, 60) : e}`);
  }
}
