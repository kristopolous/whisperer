/** Decide whether a patch actually fixes anything.
 *
 *  Deliberately separate from whatever produced the patch. Writing a good fix
 *  for an unfamiliar repository is hard and increasingly something to buy
 *  rather than build; checking one is cheap, mechanical, and the only thing
 *  that turns "it is fixed" from a claim into a fact. So this takes a diff and
 *  a checkout and knows nothing about where the diff came from — our own fix
 *  agent, a vendor's API, or a person pasting one in.
 *
 *  Three questions, in order, and each is worthless without the ones before it:
 *
 *   1. Did the suite pass BEFORE the change? A green run after a patch proves
 *      nothing if it was green because the suite was already broken, or amber
 *      because it never ran.
 *   2. Does the suite pass after applying it?
 *   3. Does the new test FAIL against the original code? This is the one that
 *      catches the confident patch that changes nothing. A test asserting
 *      `assert True` passes on both, and without this check it reads as proof.
 *
 *  Nothing here mutates the checkout it is given. Everything happens in throwaway
 *  copies which are removed afterwards, so a verification can be run against a
 *  repository somebody cares about.
 */

import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface PatchFile { path: string; contents: string }

export interface TestCommand { cmd: string; args: string[] }

export interface Verdict {
  /** The suite was green before anything was touched. */
  baselineGreen: boolean;
  /** The suite is green with the patch applied. */
  passed: boolean;
  /** Whether a new test was found, and whether it fails without the fix. */
  provesTheBug: { checked: boolean; failedOnOriginal: boolean; detail: string };
  /** Test output, for the record — truncated, never rewritten. */
  output: string;
  /** True only when all three questions were answered the right way. */
  trustworthy: boolean;
}

async function runTests(dir: string, test: TestCommand) {
  try {
    const { stdout, stderr } = await run(test.cmd, test.args, {
      cwd: dir, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
    });
    return { passed: true, output: `${stdout}${stderr}`.trim().slice(0, 4_000) };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    return {
      passed: false,
      output: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}`.trim().slice(0, 4_000),
    };
  }
}

/** Remove compiled-artifact caches from a checkout.
 *
 *  Called after writing a patch into a directory the test suite has already run
 *  in. Interpreters cache compiled output keyed on the source file's size and
 *  modification time, and a small edit — `a - b` to `a + b` — changes neither
 *  within the same second, so the stale object is reused and the patch appears
 *  to do nothing. The failure is silent and points the wrong way: a correct fix
 *  is reported as not working. */
export function purgeCaches(dir: string): void {
  const names = ['__pycache__', '.pytest_cache', '.ruff_cache', '.mypy_cache', '.tsbuildinfo'];
  const walk = (at: string, depth: number) => {
    if (depth > 6) return;
    let entries: { name: string; isDirectory(): boolean }[];
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(at, entry.name);
      if (names.includes(entry.name)) {
        rmSync(full, { recursive: true, force: true });
        continue;
      }
      // `node_modules` is enormous and holds nothing that a patch invalidates.
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
        walk(full, depth + 1);
      }
    }
  };
  walk(dir, 0);
}

/** Files that look like tests rather than product code.
 *
 *  Matched on path rather than content: a change under `tests/` or named
 *  `test_*` is the new test, and everything else is the fix. Getting this wrong
 *  in the permissive direction would copy the fix onto the control checkout and
 *  the control would then pass, reporting a good patch as unproven — the safe
 *  direction, which is why the rule is narrow. */
export const testFilesIn = (files: PatchFile[]): PatchFile[] =>
  files.filter((f) => /(^|\/)tests?\//.test(f.path) || /test_/.test(path.basename(f.path)));

/** Apply `files` to a copy of `repo` and answer the three questions.
 *
 *  `repo` is never written to. */
export async function verifyPatch(
  repo: string,
  files: PatchFile[],
  test: TestCommand,
  emit: (level: 'info' | 'warn', text: string) => void = () => {},
): Promise<Verdict> {
  const stamp = Date.now().toString(36);
  const before = path.resolve(`${repo}-baseline-${stamp}`);
  const patched = path.resolve(`${repo}-verify-${stamp}`);
  const control = path.resolve(`${repo}-control-${stamp}`);

  try {
    // The baseline runs in its OWN copy, and that is not tidiness.
    //
    // Running it in the copy we are about to patch leaves compiled bytecode
    // behind — `__pycache__` for Python, and the same shape of thing for other
    // toolchains — keyed on the source file's size and mtime. A one-character
    // fix like `a - b` → `a + b` changes neither within the same second, so the
    // interpreter reuses the stale object and the patch silently does nothing.
    // It fails in the worst direction: a correct fix is reported as broken.
    rmSync(before, { recursive: true, force: true });
    cpSync(repo, before, { recursive: true });
    const baseline = await runTests(before, test);
    emit('info', `baseline: ${test.cmd} ${test.args.join(' ')} ${baseline.passed ? 'passes' : 'FAILS'}`);
    if (!baseline.passed) {
      emit('warn', 'the suite was already failing — a pass afterwards would not mean anything');
    }

    rmSync(patched, { recursive: true, force: true });
    cpSync(repo, patched, { recursive: true });

    for (const file of files) {
      const target = path.resolve(patched, file.path);
      // Refuse a path that climbs out of the checkout. A patch is text from
      // somewhere else, and `../../etc/thing` is a file write outside the
      // directory this was told it could touch.
      if (!target.startsWith(path.resolve(patched) + path.sep)) {
        throw new Error(`patch tried to write outside the checkout: ${file.path}`);
      }
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, file.contents);
    }

    const after = await runTests(patched, test);
    emit(after.passed ? 'info' : 'warn', `with the patch: ${after.passed ? 'tests pass' : 'tests FAIL'}`);

    // The control: the new tests on top of untouched code.
    let provesTheBug = { checked: false, failedOnOriginal: false, detail: 'no new test was added, so nothing proves the bug was caught' };
    const tests = testFilesIn(files);
    if (after.passed && tests.length) {
      rmSync(control, { recursive: true, force: true });
      cpSync(repo, control, { recursive: true });
      for (const file of tests) {
        const target = path.resolve(control, file.path);
        if (!target.startsWith(path.resolve(control) + path.sep)) continue;
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, file.contents);
      }
      const original = await runTests(control, test);
      provesTheBug = {
        checked: true,
        failedOnOriginal: !original.passed,
        detail: original.passed
          ? 'the new test PASSES against the original code, so it does not test the fix'
          : 'the new test fails against the original code, as it should',
      };
      emit(provesTheBug.failedOnOriginal ? 'info' : 'warn', `regression test vs original: ${provesTheBug.detail}`);
    }

    return {
      baselineGreen: baseline.passed,
      passed: after.passed,
      provesTheBug,
      output: after.output,
      // All three, and nothing less. This is the value the loop should report a
      // fix on; anything else is a patch that has not earned the word.
      trustworthy: baseline.passed && after.passed && provesTheBug.checked && provesTheBug.failedOnOriginal,
    };
  } finally {
    rmSync(before, { recursive: true, force: true });
    rmSync(patched, { recursive: true, force: true });
    rmSync(control, { recursive: true, force: true });
  }
}
