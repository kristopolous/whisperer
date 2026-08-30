/** Rebuild exactly what fixIssue sends, and try it directly. */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fixAgent } from '../app/server/agents/fix.ts';
import { askJsonDirect } from '../app/server/model.ts';
import { fixSchema } from '../app/server/schemas.ts';

const repo = 'data/repos/hangman-test';
const suspects = ['hangman.py', 'words.py'];
const sources = suspects.map((p) => ({ path: p, contents: readFileSync(path.join(repo, p), 'utf8').slice(0, 20_000) }));
const testFile = path.join(repo, 'tests/test_hangman.py');
if (existsSync(testFile)) sources.push({ path: 'tests/test_hangman.py', contents: readFileSync(testFile, 'utf8') });

const prompt = `Product: "hangman-test".

Issue:
${JSON.stringify({ title: 'Letter q cannot be guessed', kind: 'bug', severity: 'serious', summary: 'The letter q cannot be entered as a guess.', impact: 'Words containing q are unwinnable.' })}

Diagnosis:
${JSON.stringify({ cause: "The letter 'q' is hardcoded as the quit command.", fix: 'Use a multi-character quit command.', test: 'assert prompt_guess accepts q' })}

Tests are run with: python3 -m pytest tests/ -q

Current files:
${sources.map((f) => `--- ${f.path}\n${f.contents}`).join('\n\n')}

Return targeted edits: for each change, the exact text to find in the file and what to replace it with.`;

console.log(`prompt: ${prompt.length} chars, ${sources.length} files`);
for (let i = 1; i <= 2; i += 1) {
  const t = Date.now();
  try {
    const r = await askJsonDirect<{ edits?: unknown[] }>({
      instructions: fixAgent.instructions, prompt, schema: fixSchema, role: 'coding', timeoutMs: 240_000,
    });
    console.log(`try ${i}: ok in ${Math.round((Date.now() - t) / 1000)}s — ${r.edits?.length ?? 0} edit(s)`);
  } catch (e) {
    console.log(`try ${i}: FAIL in ${Math.round((Date.now() - t) / 1000)}s — ${e instanceof Error ? e.message.slice(0, 60) : e}`);
  }
}
