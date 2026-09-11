/** How to run a test in this project — and if it has no way, how to give it one.
 *
 *  The pipeline's claim is that a defect is demonstrated and a fix works, and the
 *  only thing that can establish either is running code. Reading the source and
 *  reasoning about it is how the diagnosis is produced; it is not evidence, and a
 *  patch backed by nothing but a confident reading is exactly what the verify
 *  step exists to refuse.
 *
 *  So "this project has no test framework" cannot be an answer. It was: the run
 *  looked for a suite, found none, and refused — which reads as caution and is
 *  actually a refusal to do the job, because most of the small and interesting
 *  repositories in this pipeline have no tests at all, and those are the ones
 *  where a demonstrated defect is worth the most to whoever maintains them.
 *
 *  What a project can lack is a *suite*. It cannot lack a way to execute its own
 *  language: a Python project has `unittest` in the standard library whether or
 *  not it has pytest, Node has had a test runner built in since 18, Cargo and Go
 *  ship theirs. So when there is no suite, one is established — a directory, a
 *  naming convention, and a command that runs it — and that fact is recorded
 *  rather than hidden, because "the suite was green before" means something
 *  different when the suite is one file old.
 *
 *  The runner is verified by running it, not by inferring it from a file on disk.
 *  A pyproject.toml listing pytest says what the author intended; `python3 -c
 *  "import pytest"` says what this machine can do, and a plan built on the first
 *  fails at the moment it matters with an error that looks like a broken test.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface TestCommand { cmd: string; args: string[] }

export interface TestPlan {
  /** Everything this runner runs. For a project with a suite, its suite. */
  suite: TestCommand;
  /** The same runner pointed at particular files, when it can be.
   *
   *  Worth having because "the suite went red" says nothing about which test did
   *  it, and the claim being recorded is usually about one test. Null when the
   *  runner cannot be narrowed, and the caller then has to read the result
   *  against a baseline instead. */
  only: ((paths: string[]) => TestCommand) | null;
  /** Where a new test file goes, and what it must be called to be collected. */
  place: { dir: string; naming: string; example: string };
  /** `project` when the project already had a suite; `established` when it had
   *  none and this plan is the convention being introduced. The distinction is
   *  load-bearing for how any result should be read. */
  origin: 'project' | 'established';
  language: 'python' | 'javascript' | 'rust' | 'go' | 'unknown';
  /** One line for the log and the record. */
  note: string;
}

/** Does this command work here? Runs it and looks at the exit code.
 *
 *  Cheap — a version flag or an import — and the only honest way to know. */
async function works(cmd: string, args: string[], cwd: string): Promise<boolean> {
  try {
    await run(cmd, args, { cwd, timeout: 20_000, maxBuffer: 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

/** Which language is this, by weight of source files.
 *
 *  Counted rather than sniffed from one manifest: plenty of Python projects carry
 *  a package.json for their docs site, and a plan built on that would write
 *  JavaScript tests for a Python defect. */
function languageOf(repo: string): TestPlan['language'] {
  const counts = { python: 0, javascript: 0, rust: 0, go: 0 };
  const walk = (at: string, depth: number) => {
    if (depth > 4) return;
    let entries: { name: string; isDirectory(): boolean }[];
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      if (entry.isDirectory()) { walk(path.join(at, entry.name), depth + 1); continue; }
      if (entry.name.endsWith('.py')) counts.python += 1;
      else if (/\.[cm]?[jt]sx?$/.test(entry.name)) counts.javascript += 1;
      else if (entry.name.endsWith('.rs')) counts.rust += 1;
      else if (entry.name.endsWith('.go')) counts.go += 1;
    }
  };
  walk(repo, 0);

  const [best, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] as [TestPlan['language'], number];
  return count > 0 ? best : 'unknown';
}

const hasTestFiles = (dir: string, pattern: RegExp): boolean => {
  try {
    return readdirSync(dir).some((name) => pattern.test(name));
  } catch {
    return false;
  }
};

/** A test directory the project already uses, or null. */
function existingTestDir(repo: string): string | null {
  // Depth two, because a monorepo keeps them at packages/<name>/tests.
  const candidates: string[] = [];
  const walk = (at: string, depth: number) => {
    if (depth > 3) return;
    let entries: { name: string; isDirectory(): boolean }[];
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(at, entry.name);
      if (/^tests?$/.test(entry.name)) candidates.push(full);
      else walk(full, depth + 1);
    }
  };
  walk(repo, 0);
  // The shallowest, which is the project's own rather than a vendored one.
  return candidates.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length)[0] ?? null;
}

const pytest = (paths: string[]): TestCommand => ({ cmd: 'python3', args: ['-m', 'pytest', ...paths, '-q'] });

/** Work out how to run a test here, establishing a way if there is none.
 *
 *  Null only when this machine cannot execute the project's language at all —
 *  which is a fact about the machine, reportable as such, and the one case where
 *  refusing is honest. */
export async function testPlanFor(repo: string): Promise<TestPlan | null> {
  const language = languageOf(repo);
  const testDir = existingTestDir(repo);

  /* ---------------------------------------------------------------- python */
  if (language === 'python') {
    const hasPytest = await works('python3', ['-c', 'import pytest'], repo);
    const suiteDir = testDir ? path.relative(repo, testDir) : 'tests';
    const collected = testDir && hasTestFiles(testDir, /^test_.*\.py$|_test\.py$/);

    if (hasPytest) {
      return {
        suite: pytest([suiteDir]),
        only: pytest,
        place: { dir: suiteDir, naming: 'test_<what_it_asserts>.py', example: `${suiteDir}/test_blank_rows.py` },
        origin: collected ? 'project' : 'established',
        language,
        note: collected
          ? `pytest, over the project's own ${suiteDir}/`
          : `pytest is available but this project has no tests — adding the first in ${suiteDir}/`,
      };
    }

    // No pytest on this machine. unittest is in the standard library, so a
    // Python project always has a runner; it just needs the test written as a
    // TestCase rather than a bare function.
    if (await works('python3', ['-c', 'import unittest'], repo)) {
      return {
        suite: { cmd: 'python3', args: ['-m', 'unittest', 'discover', '-s', suiteDir, '-v'] },
        only: (paths) => ({
          cmd: 'python3',
          args: ['-m', 'unittest', '-v', ...paths.map((p) => p.replace(/\.py$/, '').split(path.sep).join('.'))],
        }),
        place: { dir: suiteDir, naming: 'test_<what_it_asserts>.py, one unittest.TestCase', example: `${suiteDir}/test_blank_rows.py` },
        origin: collected ? 'project' : 'established',
        language,
        note: `python3 -m unittest (pytest is not installed here), over ${suiteDir}/`,
      };
    }
    return null;
  }

  /* ------------------------------------------------------------ javascript */
  if (language === 'javascript') {
    const pkgPath = path.join(repo, 'package.json');
    const script = (() => {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
        return pkg.scripts?.test;
      } catch {
        return undefined;
      }
    })();
    // A package.json test script that is a placeholder is not a suite. npm's
    // own `npm init` writes one that exits 1 with "no test specified", and
    // treating that as the project's suite makes every baseline red.
    const realScript = script && !/no test specified/i.test(script) ? script : undefined;

    if (realScript && existsSync(path.join(repo, 'node_modules'))) {
      return {
        suite: { cmd: 'npm', args: ['test', '--silent'] },
        // Not narrowable: the script can be anything, and appending a path to
        // `npm test` passes it to whatever the script happens to be.
        only: null,
        place: {
          dir: testDir ? path.relative(repo, testDir) : 'test',
          naming: "match the project's existing test files",
          example: `${testDir ? path.relative(repo, testDir) : 'test'}/blank-rows.test.js`,
        },
        origin: 'project',
        language,
        note: `npm test — \`${realScript}\``,
      };
    }

    // Node's own runner. Built in since 18, no dependency to install, and it
    // collects `*.test.js` — which is why the naming below is not negotiable.
    if (await works('node', ['--test', '--test-name-pattern', 'nothing-matches-this'], repo)
      || await works('node', ['--version'], repo)) {
      const dir = testDir ? path.relative(repo, testDir) : 'test';
      return {
        suite: { cmd: 'node', args: ['--test', dir] },
        only: (paths) => ({ cmd: 'node', args: ['--test', ...paths] }),
        place: {
          dir,
          naming: '<what_it_asserts>.test.js, using node:test and node:assert',
          example: `${dir}/blank-rows.test.js`,
        },
        origin: 'established',
        language,
        note: `node --test (the project has no usable test script) over ${dir}/`,
      };
    }
    return null;
  }

  /* ------------------------------------------------------------------ rust */
  if (language === 'rust' && await works('cargo', ['--version'], repo)) {
    return {
      suite: { cmd: 'cargo', args: ['test'] },
      only: (paths) => ({
        cmd: 'cargo',
        args: ['test', '--test', path.basename(paths[0] ?? '').replace(/\.rs$/, '')],
      }),
      place: { dir: 'tests', naming: '<what_it_asserts>.rs with #[test] functions', example: 'tests/blank_rows.rs' },
      origin: existsSync(path.join(repo, 'tests')) ? 'project' : 'established',
      language,
      note: 'cargo test',
    };
  }

  /* -------------------------------------------------------------------- go */
  if (language === 'go' && await works('go', ['version'], repo)) {
    return {
      suite: { cmd: 'go', args: ['test', './...'] },
      only: (paths) => ({ cmd: 'go', args: ['test', ...paths.map((p) => `./${path.dirname(p)}`)] }),
      place: { dir: '.', naming: '<subject>_test.go beside the code it tests', example: 'csv/blank_rows_test.go' },
      origin: 'project',
      language,
      note: 'go test ./...',
    };
  }

  return null;
}

/** Why no plan could be made, in terms of what is missing from this machine
 *  rather than what is missing from the repository. The distinction matters: the
 *  project not having tests is something this pipeline fixes, and the host not
 *  having an interpreter is something a person has to. */
export const noRunnerReason = (repo: string): string =>
  `nothing on this machine can run code from ${path.basename(repo)} — install the language's `
  + 'toolchain (python3, node, cargo or go) and it can be tested';
