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
import { noRunnerReason, testPlanFor } from '../testing.ts';
import type { FixStep, Issue, Reproduction, Scan } from '../../shared/types.ts';
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

/* How this project runs its tests — and how to give it a way when it has none —
 * lives in ../testing.ts. It used to be a few `existsSync` checks here, which
 * answered "is there a suite" and then refused the whole run when there was not.
 * That refusal was the bug: a project without tests is the normal case for the
 * repositories worth pointing this at, and it is something to fix rather than a
 * reason to stop. */

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
  options: { maxAttempts?: number; reproduction?: Reproduction } = {},
): Promise<FixAttempt> {
  // Three, not two: one is routinely spent on a transient empty response from
  // the provider, which would otherwise leave a single real attempt.
  const maxAttempts = options.maxAttempts ?? 3;

  const plan = await testPlanFor(repo);
  if (!plan) throw new Error(noRunnerReason(repo));
  const test = plan.suite;
  const command = `${test.cmd} ${test.args.join(' ')}`;
  emit('info', plan.origin === 'established'
    ? `this project has no test suite — using ${plan.note}, so the only test here will be the one this run adds`
    : `tests run with ${plan.note}`);

  // A throwaway copy. The checkout this was pointed at is never written to.
  const workdir = path.resolve(`${repo}-work-${Date.now().toString(36)}`);
  rmSync(workdir, { recursive: true, force: true });
  mkdirSync(path.dirname(workdir), { recursive: true });
  cpSync(repo, workdir, { recursive: true });
  emit('info', `working in ${path.basename(workdir)}`);

  // A project with no suite has no baseline to take — there is nothing there to
  // pass or fail yet, and running the command would report the absence of a
  // directory as a failing test.
  const baseline = plan.origin === 'established'
    ? { passed: true, output: 'the project had no test suite; one was established for this run' }
    : await runTests(workdir, test);
  emit('info', plan.origin === 'established'
    ? 'no baseline to take — this project had no tests before this run'
    : `baseline: ${command} ${baseline.passed ? 'passes' : 'FAILS'}`);
  if (!baseline.passed) {
    emit('warn', 'the suite was already failing — a pass after the change would not mean anything');
  }

  // The failing test, if one was written before this run — and it is written
  // into the copy, not just shown to the model.
  //
  // This is what makes "fixed" mean something. The acceptance criterion is then
  // a test the patch's author did not write, already known to fail against the
  // unpatched code, and the suite going green has to include turning that red
  // line green. It goes in after the baseline deliberately: the baseline is the
  // suite as the project ships it, and the run needs both numbers — green
  // before the test, red with it, green again with the patch.
  const reproduction = options.reproduction;
  const reproTests = reproduction?.demonstrated ? reproduction.files : [];
  if (reproTests.length) {
    for (const file of reproTests) {
      const target = path.resolve(workdir, file.path);
      if (!target.startsWith(workdir + path.sep)) continue;
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, file.contents);
    }
    purgeCaches(workdir);
    const withTest = await runTests(workdir, test);
    emit(withTest.passed ? 'warn' : 'info',
      `with the reproduction added, ${command} ${withTest.passed ? 'still passes — the failing test is no longer failing' : 'fails, as it should'}`);
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

  // The reproduction is part of the working set, and the prompt says what it is
  // for: this test must go green, and must not be edited to get there.
  for (const file of reproTests) {
    sources.push({ path: file.path, contents: file.contents.slice(0, 12_000) });
  }

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
${JSON.stringify({ title: issue.title, kind: issue.kind, severity: issue.severity, summary: issue.summary, impact: issue.impact, check: issue.check })}

Diagnosis:
${JSON.stringify({ cause: diagnosis.likelyCause, fix: diagnosis.proposedFix, test: diagnosis.regressionTest })}

Tests are run with: ${command}${plan.origin === 'established' ? `\nThis project has no tests. Put the regression test at ${plan.place.dir}/, named ${plan.place.naming} — for example ${plan.place.example} — or the runner will not collect it.` : ''}
${reproTests.length ? `\nA test demonstrating this defect has already been written and is in the working copy: ${reproTests.map((f) => f.path).join(', ')}. It fails against the current code — ${reproduction!.detail}. Your patch must make it pass. Do not edit it, and do not weaken it; it is the acceptance criterion, not part of the problem.\n` : ''}
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

  // A reproduction written before the patch already answers this question, and
  // answers it better: that test was run against the unpatched code by a run
  // that could not have edited the code, and it was written without the patch to
  // shape it. Re-deriving the same fact from the patch's own tests would be
  // weaker evidence dressed as a second opinion.
  const provenAhead = reproduction?.demonstrated
    ? reproTests.filter((f) => existsSync(path.resolve(workdir, f.path)))
    : [];

  const testFiles = provenAhead.length
    ? provenAhead
    : last.files.filter((f) => /(^|\/)tests?\//.test(f.path) || /test_/.test(path.basename(f.path)));
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
        : provenAhead.length
          ? 'the test fails against the original code, as it should — and it was written before the patch, '
            + 'by a run that could not change the code it was failing against'
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
      // Three states, not two. "The suite passed before" is a claim about a suite
      // that existed, and saying it about a project that had none would credit a
      // green run that never happened.
      note: plan.origin === 'established'
        ? `this project had no test suite — ${plan.note} was established for this run, so the only `
          + 'test involved is the one it adds, and there is no prior green run behind it'
        : baseline.passed
          ? 'the suite passed before anything was changed, so a pass afterwards means something'
          : 'the suite was ALREADY failing before anything was changed — a pass afterwards proves less than it looks',
    },
    workdir,
  };
}
