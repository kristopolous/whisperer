import { readFileSync } from 'node:fs';
import { fixAgent } from '../app/server/agents/fix.ts';
import { askJsonDirect } from '../app/server/model.ts';
import { fixSchema } from '../app/server/schemas.ts';

const src = readFileSync('data/repos/hangman-test/hangman.py', 'utf8');
const noArt = src.replace(/GALLOWS = \[[\s\S]*?\n\]/, 'GALLOWS = ["(art omitted)"] * 7');

const trials: [string, string][] = [
  ['full hangman.py (with ASCII art)', src],
  ['hangman.py, art removed', noArt],
  ['just the 30 lines around QUIT_KEY', src.split('\n').slice(55, 85).join('\n')],
];

for (const [label, body] of trials) {
  const t = Date.now();
  try {
    const r = await askJsonDirect<{ edits?: unknown[] }>({
      instructions: fixAgent.instructions,
      prompt: `Product: "hangman-test".\n\nIssue: the letter q cannot be guessed because it is the quit key.\n\nCurrent file hangman.py:\n${body}\n\nReturn the edits.`,
      schema: fixSchema, role: 'coding', timeoutMs: 180_000,
    });
    console.log(`ok    ${label.padEnd(36)} ${Math.round((Date.now() - t) / 1000)}s  ${r.edits?.length ?? 0} edit(s)`);
  } catch (e) {
    console.log(`FAIL  ${label.padEnd(36)} ${Math.round((Date.now() - t) / 1000)}s  ${e instanceof Error ? e.message.slice(0, 50) : e}`);
  }
}
