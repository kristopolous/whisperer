/** The two judgements that decide whether "reproduced" means anything.
 *
 *  Both are here because both are ways the rung could quietly start lying. A
 *  test that fails on an import error is red, and anything reading the exit code
 *  alone would file a ticket claiming a demonstrated defect on the strength of
 *  it. A write outside the test directory would let the run that produces the
 *  red edit the code it is supposed to be failing against, which makes the whole
 *  step worthless whatever colour it reports.
 *
 *  Neither can be covered by running the pipeline: the interesting inputs are
 *  the ones a model produces on a bad day, and waiting for one is not a test.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { checkPath, classify, targeted } from './reproduce-run.ts';

test('a failing assertion is the only failure that counts as a reproduction', () => {
  const result = classify({
    failed: true,
    code: 1,
    output: 'E       AssertionError: trimming 20000 blank rows shifted 200010000 elements\n1 failed in 3.82s',
  });
  assert.equal(result.verdict, 'demonstrated');
});

test('a test that could not run is not a reproduction, however red it looks', () => {
  // pytest's own signals first: 2 is a collection or usage error, 5 is "nothing
  // was collected". Both exit non-zero and print in red.
  for (const code of [2, 5]) {
    assert.equal(classify({ failed: true, code, output: 'red wall of text' }).verdict, 'did-not-run');
  }

  // And the cases that exit 1 like a real failure, but never asserted anything.
  const cases = [
    'ImportError: cannot import name _trim_outer_blank_rows',
    'ModuleNotFoundError: No module named markitdown',
    'E   SyntaxError: invalid syntax',
    "E       fixture 'converter' not found",
    'collected 0 items\nno tests ran in 0.01s',
    'ERROR tests/test_repro.py - errors during collection',
  ];
  for (const output of cases) {
    const result = classify({ failed: true, code: 1, output });
    assert.equal(result.verdict, 'did-not-run', output);
    // The reason is the part that goes back to the agent, so it has to say
    // something it can act on rather than "it did not run".
    assert.match(result.detail, /—\s\S/);
  }
});

test('a test that passes against the current code demonstrates nothing', () => {
  const result = classify({ failed: false, code: 0, output: '4 passed in 0.59s' });
  assert.equal(result.verdict, 'passed');
  assert.match(result.detail, /does not demonstrate/);
});

test('only a new test file may be written', () => {
  const workdir = mkdtempSync(path.join(tmpdir(), 'repro-'));
  mkdirSync(path.join(workdir, 'tests'), { recursive: true });
  writeFileSync(path.join(workdir, 'tests', 'test_existing.py'), 'def test_ok():\n    assert True\n');
  mkdirSync(path.join(workdir, 'src'), { recursive: true });
  writeFileSync(path.join(workdir, 'src', 'converter.py'), 'x = 1\n');

  const ok = checkPath(workdir, 'tests/test_blank_rows.py');
  assert.equal(ok.ok, true);

  // The refusal that matters most: a reproduction that can edit the code under
  // test can make its own red, and then the red means nothing.
  const source = checkPath(workdir, 'src/converter.py');
  assert.equal(source.ok, false);
  assert.match((source as { why: string }).why, /may only add tests/);

  // Replacing a passing test is another way to turn a suite red without a
  // defect being involved.
  const existing = checkPath(workdir, 'tests/test_existing.py');
  assert.equal(existing.ok, false);
  assert.match((existing as { why: string }).why, /already exists/);

  const escape = checkPath(workdir, '../../etc/tests/test_evil.py');
  assert.equal(escape.ok, false);
  assert.match((escape as { why: string }).why, /escapes the working copy/);
});

test('the new test is run on its own where the runner allows it', () => {
  const pytest = targeted({ cmd: 'python3', args: ['-m', 'pytest', 'tests/', '-q'] }, ['tests/test_a.py']);
  assert.deepEqual(pytest, { cmd: 'python3', args: ['-m', 'pytest', 'tests/test_a.py', '-q'] });

  // Anything else falls back to the whole suite, which the caller then has to
  // read against the baseline rather than as a statement about one test.
  assert.equal(targeted({ cmd: 'npm', args: ['test', '--silent'] }, ['tests/a.test.ts']), null);
});
