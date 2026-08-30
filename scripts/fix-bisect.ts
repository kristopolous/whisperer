import { readFileSync } from 'node:fs';
import { fixAgent } from '../app/server/agents/fix.ts';
import { askJsonDirect } from '../app/server/model.ts';
import { fixSchema } from '../app/server/schemas.ts';

const read = (p: string) => readFileSync(`data/repos/hangman-test/${p}`, 'utf8');
const combos: [string, string[]][] = [
  ['hangman.py only', ['hangman.py']],
  ['hangman.py + words.py', ['hangman.py', 'words.py']],
  ['hangman.py + tests', ['hangman.py', 'tests/test_hangman.py']],
  ['words.py + tests', ['words.py', 'tests/test_hangman.py']],
  ['tests only', ['tests/test_hangman.py']],
];

for (const [label, files] of combos) {
  const prompt = `Product: "hangman-test".\n\nIssue: the letter q cannot be guessed because it is the quit key.\n\nCurrent files:\n${files.map((f) => `--- ${f}\n${read(f)}`).join('\n\n')}\n\nReturn targeted edits.`;
  const t = Date.now();
  try {
    const r = await askJsonDirect<{ edits?: unknown[] }>({
      instructions: fixAgent.instructions, prompt, schema: fixSchema, role: 'coding', timeoutMs: 180_000,
    });
    console.log(`ok    ${label.padEnd(26)} ${String(prompt.length).padStart(5)}ch  ${Math.round((Date.now() - t) / 1000)}s  ${r.edits?.length ?? 0} edit(s)`);
  } catch (e) {
    console.log(`FAIL  ${label.padEnd(26)} ${String(prompt.length).padStart(5)}ch  ${Math.round((Date.now() - t) / 1000)}s  ${e instanceof Error ? e.message.slice(0, 40) : e}`);
  }
}
