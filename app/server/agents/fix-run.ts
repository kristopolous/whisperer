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
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Issue, Scan } from '../../shared/types.ts';
import { fixAgent } from './fix.ts';
import type { Diagnosis } from './diagnose-run.ts';
import { runAgent } from './runtime.ts';

const run = promisify(execFile);

export interface FixedFile {
  path: string;
  contents: string;
  why: string;
}

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
  const maxAttempts = options.maxAttempts ?? 2;

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

  while (attempts < maxAttempts) {
    attempts += 1;

    const drafted = await runAgent<{ summary: string; notes: string; files: FixedFile[] }>(fixAgent, {
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

Return the complete new contents of every file you change.`,
      items: sources.length,
      timeoutMs: 600_000,
    });

    last = drafted;
    if (!drafted.files?.length) {
      emit('warn', `attempt ${attempts}: no files returned — ${drafted.notes?.slice(0, 160) ?? 'no reason given'}`);
      break;
    }

    for (const file of drafted.files) {
      // Written inside the workdir only. A path that escapes it is refused
      // rather than sanitised: there is no legitimate reason for one.
      const target = path.resolve(workdir, file.path);
      if (!target.startsWith(workdir + path.sep)) {
        throw new Error(`refusing to write outside the working copy: ${file.path}`);
      }
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, file.contents);
    }
    emit('info', `attempt ${attempts}: wrote ${drafted.files.length} file(s) — ${drafted.files.map((f) => f.path).join(', ')}`);

    result = await runTests(workdir, test);
    emit(result.passed ? 'info' : 'warn', `attempt ${attempts}: tests ${result.passed ? 'pass' : 'FAIL'}`);
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
    workdir,
  };
}
