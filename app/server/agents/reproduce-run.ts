/** Get a failing test out of a diagnosis, in a throwaway copy.
 *
 *  This is the step that turns "somebody says this is broken" into "here is a
 *  test that proves it", which is the difference between a rumour with a
 *  severity attached and a bug report a maintainer can act on. Filing is gated
 *  on it for exactly that reason.
 *
 *  The invariant this run exists to hold: nothing here may touch the code under
 *  test. The agent can only return new test files, every path is checked against
 *  that before it is written, and an attempt that tries to edit the source — or
 *  an existing test — is refused rather than applied. A red-then-green result is
 *  worthless if the runner that produced the red was allowed to write the code.
 *
 *  A test failing is not enough, either. A test that fails because it imports a
 *  module that does not exist fails just as red as one that catches the defect,
 *  and it would be recorded as a reproduction by anything that only looks at the
 *  exit code. So the failure is classified: an assertion about behaviour counts,
 *  a test that could not be collected or never ran does not, and the attempt goes
 *  back to the agent with the output attached.
 */

import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { why } from '../errors.ts';
import { purgeCaches } from '../verify.ts';
import type { Issue, Reproduction, ReproductionStep, Scan } from '../../shared/types.ts';
import type { Diagnosis } from './diagnose-run.ts';
import { detectTestCommand } from './fix-run.ts';
import { reproduceAgent } from './reproduce.ts';
import { runAgent } from './runtime.ts';

const run = promisify(execFile);

export interface TestCommand { cmd: string; args: string[] }

export interface Outcome {
  /** Non-zero exit, whatever the reason. */
  failed: boolean;
  /** Process exit code, which is how pytest distinguishes a failing assertion
   *  (1) from a collection error (2) from "no tests ran" (5). */
  code: number;
  output: string;
}

async function runCommand(dir: string, test: TestCommand): Promise<Outcome> {
  try {
    const { stdout, stderr } = await run(test.cmd, test.args, {
      cwd: dir, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
    });
    return { failed: false, code: 0, output: `${stdout}${stderr}`.trim().slice(0, 4_000) };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string; code?: number | string };
    return {
      failed: true,
      code: typeof e.code === 'number' ? e.code : 1,
      output: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}`.trim().slice(0, 4_000),
    };
  }
}

/** The same runner, pointed at only the files that were just added.
 *
 *  Worth the trouble because the whole suite going red says nothing about which
 *  test did it, and the claim being recorded is specifically that THIS test
 *  fails. Only pytest is targeted here; for the others the fallback is the
 *  comparison the suite already supports — green before, red after — which is
 *  weaker but not a guess. */
export function targeted(test: TestCommand, paths: string[]): TestCommand | null {
  const pytest = test.args[0] === '-m' && test.args[1] === 'pytest';
  if (pytest) return { cmd: test.cmd, args: ['-m', 'pytest', ...paths, '-q'] };
  return null;
}

/** Did the test fail because the behaviour is wrong, or because the test is?
 *
 *  The distinction the exit code alone cannot make, and the one that decides
 *  whether a reproduction gets recorded. Erring towards `did-not-run` is
 *  deliberate: recording a broken test as a demonstration would put a false
 *  proof in front of the filing step, while a rejected good test just costs
 *  another attempt. */
export function classify(outcome: Outcome): { verdict: 'demonstrated' | 'passed' | 'did-not-run'; detail: string } {
  if (!outcome.failed) {
    return {
      verdict: 'passed',
      detail: 'the new test PASSES against the current code, so it does not demonstrate the defect',
    };
  }

  const output = outcome.output;
  // pytest: 2 is a collection or usage error, 5 is "no tests were collected".
  // Both mean nothing ran, however red the output looks.
  if (outcome.code === 2 || outcome.code === 5) {
    return { verdict: 'did-not-run', detail: `the test never ran (exit ${outcome.code})` };
  }
  // Named rather than matched anonymously, because the reason goes into the
  // record and back to the agent as the thing to fix. "it did not run" is not
  // actionable; "it could not import what it referred to" is.
  const BROKEN: [RegExp, string][] = [
    [/errors? during collection/i, 'the file could not be collected'],
    [/\bImportError\b|\bModuleNotFoundError\b/, 'it imported something that is not there'],
    [/\bSyntaxError\b|\bIndentationError\b/, 'it does not parse'],
    [/\bNameError\b/, 'it referred to a name that does not exist'],
    [/\bfixture .* not found\b/i, 'it asked for a fixture the project does not define'],
    [/\bno tests ran\b|\bcollected 0 items\b/i, 'nothing in it was collected as a test'],
  ];
  const broken = BROKEN.find(([pattern]) => pattern.test(output));
  if (broken) {
    return {
      verdict: 'did-not-run',
      detail: `the test failed before it could assert anything — ${broken[1]}`,
    };
  }

  return {
    verdict: 'demonstrated',
    detail: 'the new test fails against the current code, on an assertion about the reported behaviour',
  };
}

/** A test file from the project, to write the new one like.
 *
 *  Style is not decoration here: a test that does not match the project's
 *  imports, fixtures and naming does not get collected, and a test that is not
 *  collected reads as coverage while proving nothing. Preference goes to a file
 *  the diagnosis is already near — the tests for the module in question are the
 *  ones whose helpers the new test should be reusing. */
function sampleTest(repo: string, near: string[]): { path: string; contents: string } | null {
  const found: string[] = [];
  const walk = (at: string, depth: number) => {
    if (depth > 4 || found.length > 400) return;
    let entries: { name: string; isDirectory(): boolean }[];
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (/^test_.*\.py$|_test\.py$|\.test\.[tj]sx?$|_test\.go$/.test(entry.name)) found.push(full);
    }
  };
  walk(repo, 0);
  if (!found.length) return null;

  // The test file sharing the most path with a suspect file, falling back to
  // whichever is shortest — which in practice is the project's main test module.
  const score = (file: string) => {
    const relative = path.relative(repo, file);
    const hit = near.find((suspect) => {
      const stem = path.basename(suspect).replace(/\.[^.]+$/, '').replace(/^_+/, '');
      return stem.length > 3 && relative.includes(stem);
    });
    return (hit ? 0 : 1) * 1_000 + relative.length;
  };
  const best = found.sort((a, b) => score(a) - score(b))[0]!;
  return { path: path.relative(repo, best), contents: readFileSync(best, 'utf8').slice(0, 10_000) };
}

/** Is this a new test file, and only that?
 *
 *  Three refusals, each one a way the step could quietly stop meaning anything:
 *  a path outside the working copy, a path that is not a test, and a path that
 *  already exists — because overwriting a passing test is how a suite goes red
 *  without any defect being involved. */
export function checkPath(workdir: string, candidate: string): { ok: true; target: string } | { ok: false; why: string } {
  const target = path.resolve(workdir, candidate);
  if (!target.startsWith(workdir + path.sep)) {
    return { ok: false, why: `path escapes the working copy: ${candidate}` };
  }
  const relative = path.relative(workdir, target);
  const looksLikeTest = /(^|\/)tests?(\/|$)/.test(relative)
    || /^test_|_test\.|\.test\./.test(path.basename(relative));
  if (!looksLikeTest) {
    return {
      ok: false,
      why: `${relative} is not a test file — a reproduction may only add tests, never change the code under test`,
    };
  }
  if (existsSync(target)) {
    return { ok: false, why: `${relative} already exists — write a new test file instead of replacing one` };
  }
  return { ok: true, target };
}

export async function reproduceIssue(
  scan: Scan,
  issue: Issue,
  diagnosis: Diagnosis,
  repo: string,
  emit: (level: 'info' | 'warn', text: string) => void,
  options: { maxAttempts?: number } = {},
): Promise<Omit<Reproduction, 'at'>> {
  const maxAttempts = options.maxAttempts ?? 3;

  const test = detectTestCommand(repo);
  if (!test) throw new Error(`cannot tell how to run tests in ${repo} — refusing to claim a defect is reproduced`);
  const suiteCommand = `${test.cmd} ${test.args.join(' ')}`;

  const workdir = path.resolve(`${repo}-repro-${Date.now().toString(36)}`);
  rmSync(workdir, { recursive: true, force: true });
  mkdirSync(path.dirname(workdir), { recursive: true });
  cpSync(repo, workdir, { recursive: true });
  emit('info', `working in ${path.basename(workdir)}`);

  // The suite before the test exists. A suite that is already red cannot tell
  // you that a new red line is the new test's, so the fallback comparison for
  // runners that cannot be targeted depends on this being green — and either
  // way the reader needs to know.
  const baseline = await runCommand(workdir, test);
  emit(baseline.failed ? 'warn' : 'info', `baseline: ${suiteCommand} ${baseline.failed ? 'FAILS' : 'passes'}`);

  const suspects = diagnosis.suspectFiles
    .map((f) => f.path)
    .filter((p) => existsSync(path.join(workdir, p)))
    .slice(0, 4);

  const sources = suspects.map((p) => ({
    path: p,
    contents: readFileSync(path.join(workdir, p), 'utf8').slice(0, 20_000),
  }));
  const sample = sampleTest(workdir, suspects);
  if (sample) emit('info', `writing the test like ${sample.path}`);

  const trail: ReproductionStep[] = [];
  let attempts = 0;
  let feedback = '';
  let last: { summary: string; notes: string; expectedFailure: string; files: Reproduction['files'] } = {
    summary: '', notes: '', expectedFailure: '', files: [],
  };
  let outcome: Outcome = { failed: false, code: 0, output: '' };
  let command = suiteCommand;
  let verdict: ReturnType<typeof classify> = {
    verdict: 'passed', detail: 'no test was produced',
  };

  while (attempts < maxAttempts) {
    attempts += 1;
    const record = (entry: Omit<ReproductionStep, 'n' | 'at'>) => {
      trail.push({ n: attempts, at: new Date().toISOString(), ...entry });
    };

    let drafted: { summary: string; notes: string; expectedFailure: string; files: Reproduction['files'] };
    try {
      drafted = await runAgent<{
        summary: string; notes: string; expectedFailure: string; files: Reproduction['files'];
      }>(reproduceAgent, {
        scanId: scan.id,
        note: `${issue.title.slice(0, 40)} (attempt ${attempts})`,
        prompt: `Product: "${scan.company}".

Issue as it was reported:
${JSON.stringify({ title: issue.title, kind: issue.kind, severity: issue.severity, summary: issue.summary, impact: issue.impact, check: issue.check })}

Diagnosis:
${JSON.stringify({ verdict: diagnosis.verdict, cause: diagnosis.likelyCause, test: diagnosis.regressionTest, unknowns: diagnosis.unknowns })}

Tests are run with: ${suiteCommand}

Current code, which your test must fail against:
${sources.map((f) => `--- ${f.path}\n${f.contents}`).join('\n\n')}

${sample ? `An existing test file from this project. Match it — imports, naming, fixtures, style:\n--- ${sample.path}\n${sample.contents}` : 'This project has no test files to copy the style of. Follow the conventions of its test runner.'}
${feedback ? `\n${feedback}\n` : ''}
Write the test that fails against the code above, for the reason in the report. Do not fix anything.`,
        items: sources.length,
        timeoutMs: 600_000,
      });
    } catch (error) {
      const reason = why(error);
      emit('warn', `attempt ${attempts}: the model call failed — ${reason}`);
      record({ files: [], rejected: [], modelError: reason, outcome: 'model-failed' });
      feedback = `Your previous attempt did not return a usable answer (${reason}). Try again.`;
      continue;
    }

    const files = drafted.files ?? [];
    last = {
      summary: drafted.summary ?? '',
      notes: drafted.notes ?? '',
      expectedFailure: drafted.expectedFailure ?? '',
      files: [],
    };

    if (!files.length) {
      emit('warn', `attempt ${attempts}: no test returned — ${drafted.notes?.slice(0, 160) ?? 'no reason given'}`);
      record({
        files: [], rejected: [],
        modelError: drafted.notes?.slice(0, 300) || 'the model returned no test and gave no reason',
        outcome: 'no-files',
      });
      // A stated inability to demonstrate the defect is an answer, not a
      // transient failure — asking again produces the same answer more slowly.
      break;
    }

    const written: Reproduction['files'] = [];
    const rejected: string[] = [];
    for (const file of files) {
      const check = checkPath(workdir, file.path ?? '');
      if (!check.ok) { rejected.push(check.why); continue; }
      mkdirSync(path.dirname(check.target), { recursive: true });
      writeFileSync(check.target, file.contents ?? '');
      written.push({ path: path.relative(workdir, check.target), contents: file.contents ?? '', why: file.why ?? '' });
    }
    if (rejected.length) emit('warn', `attempt ${attempts}: ${rejected.length} file(s) refused — ${rejected[0]}`);
    if (!written.length) {
      feedback = `None of the files you returned could be written:\n${rejected.join('\n')}\nReturn a NEW test file inside the project's test directory.`;
      record({ files: [], rejected: rejected.slice(0, 6), outcome: 'retried' });
      continue;
    }

    last.files = written;
    // The suite has already run here, so there is compiled output keyed on each
    // file's size and mtime. Adding a file is a fresh compile, but a retry that
    // rewrites one within the same second is not.
    purgeCaches(workdir);

    const only = targeted(test, written.map((f) => f.path));
    const runner = only ?? test;
    command = `${runner.cmd} ${runner.args.join(' ')}`;
    outcome = await runCommand(workdir, runner);
    verdict = classify(outcome);

    // Without a targeted runner the claim rests on the comparison instead: the
    // suite was green, the only thing that changed is a new test file, and now
    // it is red. Said out loud rather than quietly treated as equivalent.
    if (!only && verdict.verdict === 'demonstrated') {
      verdict = baseline.failed
        ? {
          verdict: 'did-not-run',
          detail: 'the suite was already failing before the test was added, so a failure now proves nothing '
            + `about the new test (\`${suiteCommand}\` cannot be pointed at one file)`,
        }
        : {
          verdict: 'demonstrated',
          detail: `the suite passed before the test was added and fails with it (\`${suiteCommand}\` `
            + 'cannot be pointed at one file, so this is the whole suite, not the test alone)',
        };
    }

    emit(verdict.verdict === 'demonstrated' ? 'info' : 'warn',
      `attempt ${attempts}: ${written.map((f) => f.path).join(', ')} — ${verdict.detail}`);
    record({
      files: written.map((f) => ({ path: f.path, why: f.why })),
      rejected: rejected.slice(0, 6),
      outcome: verdict.verdict,
      output: outcome.output.slice(-1_200),
    });

    if (verdict.verdict === 'demonstrated') break;

    // Remove the attempt before the next one, so a retry is not sitting on top
    // of a broken file it is no longer allowed to overwrite.
    for (const file of written) rmSync(path.resolve(workdir, file.path), { force: true });
    feedback = verdict.verdict === 'passed'
      ? `Your test PASSED against the current code, so it does not demonstrate the defect. Output:\n${outcome.output.slice(-1_500)}\n\n`
        + 'Assert the behaviour the report says should happen. If the current behaviour is what your assertion checks, you have written the wrong assertion.'
      : `Your test did not run — ${verdict.detail}. Output:\n${outcome.output.slice(-1_500)}\n\n`
        + 'Fix the cause: use only imports and APIs visible in the files you were shown, and match the project\'s test layout so it gets collected.';
  }

  const demonstrated = verdict.verdict === 'demonstrated' && last.files.length > 0;
  return {
    demonstrated,
    summary: last.summary,
    notes: last.notes,
    expectedFailure: last.expectedFailure,
    files: last.files,
    test: { command, failed: outcome.failed, output: outcome.output },
    baseline: {
      passed: !baseline.failed,
      note: baseline.failed
        ? 'the suite was ALREADY failing before the test was added'
        : 'the suite passed before the test was added',
    },
    detail: verdict.detail,
    attempts,
    trail,
    workdir,
  };
}
