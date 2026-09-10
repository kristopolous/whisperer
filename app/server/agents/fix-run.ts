/** Apply a fix in a throwaway copy, run the tests, and only believe it if they
 *  pass.
 *
 *  Never touches the checkout it was pointed at, and never pushes anything. The
 *  output is a diff and a test result; turning that into a pull request is a
 *  separate, deliberate act by a person.
 *
 *  Two checks make the result worth anything:
 *
 *   - The suite is run BEFORE the change. A suite that was already failing
 *     tells you nothing about the patch, and "tests pass" afterwards would be
 *     meaningless — or worse, misleading.
 *   - The new regression test is run against the ORIGINAL source, and is
 *     expected to FAIL there. A test that passes both before and after has not
 *     tested the fix; it is the single easiest way for this whole pipeline to
 *     produce something that looks green and proves nothing.
 */

import { execFile } from 'node:child_process';
import { why } from '../errors.ts';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { purgeCaches } from '../verify.ts';
import type { FixStep, Issue, Scan } from '../../shared/types.ts';
import { fixAgent } from './fix.ts';
import type { Diagnosis } from './diagnose-run.ts';
import { runAgent } from './runtime.ts';

const run = promisify(execFile);

export interface FixedFile {
  path: string;
  contents: string;
  why: string;
}

export interface Edit {
  path: string;
  find: string;
  replace: string;
  why: string;
}

/** Apply one edit, or explain why it cannot be.
 *
 *  A `find` that matches nothing is a model quoting code that is not there; one
 *  that matches twice would be applied somewhere unintended. Both are refused
 *  rather than guessed at — the whole safety of an edit-based patch rests on
 *  the match being unambiguous. */
function applyEdit(root: string, edit: Edit): { ok: true; contents: string } | { ok: false; why: string } {
  const target = path.resolve(root, edit.path);
  if (!target.startsWith(root + path.sep)) return { ok: false, why: `path escapes the working copy: ${edit.path}` };
  if (!existsSync(target)) return { ok: false, why: `${edit.path} does not exist` };

  const before = readFileSync(target, 'utf8');
  const occurrences = before.split(edit.find).length - 1;
  if (occurrences === 0) return { ok: false, why: `the text to replace was not found in ${edit.path}` };
  if (occurrences > 1) return { ok: false, why: `the text to replace appears ${occurrences} times in ${edit.path} — not unique` };

  return { ok: true, contents: before.replace(edit.find, edit.replace) };
}

/** The result of one call to fixIssue. Named for the loop it runs, not for a
 *  single iteration of it — a single iteration is a FixStep, in shared types. */
export interface FixAttempt {
  applied: boolean;
  summary: string;
  notes: string;
  files: FixedFile[];
  /** Unified diff against the original, for review. */
  diff: string;
  /** Test result after the change. */
  tests: { command: string; passed: boolean; output: string };
  /** Did the new test actually catch the original bug? */
  provesTheBug: { checked: boolean; failedOnOriginal: boolean; detail: string };
  /** Every iteration, kept whether it worked or not. */
  trail: FixStep[];
  /** Whether the suite passed before anything was touched. */
  baseline: { passed: boolean; note: string };
  attempts: number;
  workdir: string;
}

/** How this project runs its tests. Detected rather than configured, because a
 *  repo tells you: a tests directory of test_*.py means pytest. */
export function detectTestCommand(repo: string): { cmd: string; args: string[] } | null {
  if (existsSync(path.join(repo, 'pytest.ini')) || existsSync(path.join(repo, 'tests'))) {
    return { cmd: 'python3', args: ['-m', 'pytest', 'tests/', '-q'] };
  }
  if (existsSync(path.join(repo, 'package.json'))) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
      if (pkg.scripts?.test) return { cmd: 'npm', args: ['test', '--silent'] };
    } catch { /* unreadable package.json is not a test runner */ }
  }
  if (existsSync(path.join(repo, 'Cargo.toml'))) return { cmd: 'cargo', args: ['test'] };
  if (existsSync(path.join(repo, 'go.mod'))) return { cmd: 'go', args: ['test', './...'] };
  return null;
}

async function runTests(dir: string, test: { cmd: string; args: string[] }) {
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

const gitDiff = async (dir: string) => {
  try {
    const { stdout } = await run('git', ['diff'], { cwd: dir, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  } catch {
    return '';
  }
};

export async function fixIssue(
  scan: Scan,
  issue: Issue,
  diagnosis: Diagnosis,
  repo: string,
  emit: (level: 'info' | 'warn', text: string) => void,
  options: { maxAttempts?: number } = {},
): Promise<FixAttempt> {
  // Three, not two: one is routinely spent on a transient empty response from
  // the provider, which would otherwise leave a single real attempt.
  const maxAttempts = options.maxAttempts ?? 3;

  const test = detectTestCommand(repo);
  if (!test) throw new Error(`cannot tell how to run tests in ${repo} — refusing to claim a fix works`);
  const command = `${test.cmd} ${test.args.join(' ')}`;

  // A throwaway copy. The checkout this was pointed at is never written to.
  const workdir = path.resolve(`${repo}-work-${Date.now().toString(36)}`);
  rmSync(workdir, { recursive: true, force: true });
  mkdirSync(path.dirname(workdir), { recursive: true });
  cpSync(repo, workdir, { recursive: true });
  emit('info', `working in ${path.basename(workdir)}`);

  const baseline = await runTests(workdir, test);
  emit('info', `baseline: ${command} ${baseline.passed ? 'passes' : 'FAILS'}`);
  if (!baseline.passed) {
    emit('warn', 'the suite was already failing — a pass after the change would not mean anything');
  }

  // The files the diagnosis pointed at, in full, as the model's working set.
  const targets = diagnosis.suspectFiles
    .map((f) => f.path)
    .filter((p) => existsSync(path.join(workdir, p)))
    .slice(0, 4);

  const sources = targets.map((p) => ({
    path: p,
    contents: readFileSync(path.join(workdir, p), 'utf8').slice(0, 20_000),
  }));

  // Existing tests go in too: a regression test that does not match the
  // project's imports and naming will not be collected, and a test that never
  // runs is worse than no test because it reads as coverage.
  const existingTest = ['tests/test_hangman.py', 'tests/test_main.py']
    .map((p) => path.join(workdir, p))
    .find(existsSync);
  if (existingTest) {
    sources.push({
      path: path.relative(workdir, existingTest),
      contents: readFileSync(existingTest, 'utf8').slice(0, 8_000),
    });
  }

  let last: { summary: string; notes: string; files: FixedFile[] } = { summary: '', notes: '', files: [] };
  let result = baseline;
  let attempts = 0;
  let failure = '';

  // The paper trail. Every attempt is recorded whether it worked or not — the
  // ones that failed are the ones that say whether the fix is trustworthy.
  const trail: FixStep[] = [];
  const record = (entry: Omit<FixStep, 'n' | 'at'>) => {
    trail.push({ n: attempts, at: new Date().toISOString(), ...entry });
  };

  while (attempts < maxAttempts) {
    attempts += 1;

    // A failed call is a failed attempt, not a failed stage.
    //
    // The loop already retries when the tests fail; it did not when the model
    // itself did, so one empty response — which this provider returns for
    // roughly one call in eight — threw straight out and lost the work. The
    // whole point of attempts is to absorb exactly this.
    let drafted: { summary: string; notes: string; edits: Edit[]; newFiles: FixedFile[] };
    try {
      drafted = await runAgent<{
      summary: string; notes: string; edits: Edit[]; newFiles: FixedFile[];
    }>(fixAgent, {
      scanId: scan.id,
      note: `${issue.title.slice(0, 40)} (attempt ${attempts})`,
      prompt: `Product: "${scan.company}".

Issue:
${JSON.stringify({ title: issue.title, kind: issue.kind, severity: issue.severity, summary: issue.summary, impact: issue.impact })}

Diagnosis:
${JSON.stringify({ cause: diagnosis.likelyCause, fix: diagnosis.proposedFix, test: diagnosis.regressionTest })}

Tests are run with: ${command}

Current files:
${sources.map((f) => `--- ${f.path}\n${f.contents}`).join('\n\n')}
${failure ? `\nYour previous attempt failed the tests. Output:\n${failure}\n\nFix the cause of that failure.` : ''}

Return targeted edits: for each change, the exact text to find in the file and what to replace it with. Copy the text to find character for character from the files above, and make sure it appears only once.`,
      items: sources.length,
      timeoutMs: 600_000,
      });
    } catch (error) {
      const reason = why(error);
      emit('warn', `attempt ${attempts}: the model call failed — ${reason}`);
      record({ edits: [], rejected: [], modelError: reason, outcome: 'model-failed' });
      failure = `Your previous attempt did not return a usable answer (${why}). Try again.`;
      continue;
    }

    const edits = drafted.edits ?? [];
    const newFiles = drafted.newFiles ?? [];

    if (edits.length === 0 && newFiles.length === 0) {
      last = { summary: drafted.summary, notes: drafted.notes, files: [] };
      emit('warn', `attempt ${attempts}: no changes returned — ${drafted.notes?.slice(0, 160) ?? 'no reason given'}`);
      record({
        edits: [], rejected: [],
        modelError: drafted.notes?.slice(0, 300) || 'the model returned no changes and gave no reason',
        outcome: 'no-changes',
      });
      break;
    }

    // Apply edits first, then new files. A rejected edit is reported back to
    // the model on the next attempt rather than silently skipped.
    const written = new Map<string, string>();
    const rejected: string[] = [];

    for (const edit of edits) {
      const result = applyEdit(workdir, edit);
      if (!result.ok) { rejected.push(result.why); continue; }
      writeFileSync(path.resolve(workdir, edit.path), result.contents);
      written.set(edit.path, result.contents);
    }

    for (const file of newFiles) {
      const target = path.resolve(workdir, file.path);
      if (!target.startsWith(workdir + path.sep)) {
        rejected.push(`refusing to write outside the working copy: ${file.path}`);
        continue;
      }
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, file.contents);
      written.set(file.path, file.contents);
    }

    // The suite has already run in this directory, so it has left compiled
    // output behind that is keyed on each source file's size and mtime. A
    // one-character fix changes neither within the same second and the stale
    // object is reused — the patch then appears to do nothing, and a correct
    // fix is reported as broken. Found by the verifier's own tests.
    purgeCaches(workdir);

    last = {
      summary: drafted.summary,
      notes: drafted.notes,
      files: [...written.entries()].map(([p, contents]) => ({
        path: p,
        contents,
        why: edits.find((e) => e.path === p)?.why ?? newFiles.find((f) => f.path === p)?.why ?? '',
      })),
    };

    if (rejected.length) emit('warn', `attempt ${attempts}: ${rejected.length} change(s) refused — ${rejected[0]}`);
    if (written.size === 0) {
      failure = `None of your edits could be applied:\n${rejected.join('\n')}\nCopy the text to replace exactly from the file, and make sure it appears only once.`;
      record({ edits: [], rejected: rejected.slice(0, 6), outcome: 'no-changes' });
      continue;
    }
    emit('info', `attempt ${attempts}: changed ${written.size} file(s) — ${[...written.keys()].join(', ')}`);

    result = await runTests(workdir, test);
    emit(result.passed ? 'info' : 'warn', `attempt ${attempts}: tests ${result.passed ? 'pass' : 'FAIL'}`);
    record({
      edits: last.files.map((f) => ({ path: f.path, why: f.why })),
      rejected: rejected.slice(0, 6),
      testsPassed: result.passed,
      // The tail, not the whole log: a failing suite prints thousands of lines
      // and the assertion is at the bottom.
      testOutput: result.output.slice(-1_200),
      outcome: result.passed ? 'kept' : 'retried',
    });
    if (result.passed) break;
    failure = result.output;
  }

  // Does the new test actually catch the original bug? Copy the test files onto
  // a pristine checkout and expect a failure. Without this, a test that asserts
  // nothing would sail through.
  let proves = { checked: false, failedOnOriginal: false, detail: 'not checked' };
  const testFiles = last.files.filter((f) => /(^|\/)tests?\//.test(f.path) || /test_/.test(path.basename(f.path)));
  if (result.passed && testFiles.length) {
    const control = `${workdir}-control`;
    rmSync(control, { recursive: true, force: true });
    cpSync(repo, control, { recursive: true });
    for (const file of testFiles) {
      const target = path.resolve(control, file.path);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, file.contents);
    }
    purgeCaches(control);
    const control_result = await runTests(control, test);
    proves = {
      checked: true,
      failedOnOriginal: !control_result.passed,
      detail: control_result.passed
        ? 'the new test PASSES against the original buggy code, so it does not test the fix'
        : 'the new test fails against the original code, as it should',
    };
    emit(proves.failedOnOriginal ? 'info' : 'warn', `regression test vs original: ${proves.detail}`);
    rmSync(control, { recursive: true, force: true });
  }

  return {
    applied: result.passed && last.files.length > 0,
    summary: last.summary,
    notes: last.notes,
    files: last.files,
    diff: await gitDiff(workdir),
    tests: { command, passed: result.passed, output: result.output },
    provesTheBug: proves,
    attempts,
    trail,
    baseline: {
      passed: baseline.passed,
      note: baseline.passed
        ? 'the suite passed before anything was changed, so a pass afterwards means something'
        : 'the suite was ALREADY failing before anything was changed — a pass afterwards proves less than it looks',
    },
    workdir,
  };
}
