/** A project without tests still has to be testable.
 *
 *  This is the case the pipeline used to refuse — "cannot tell how to run tests
 *  in <repo>" — and refusing it means the only evidence left for "the defect is
 *  real" or "the fix works" is a model's opinion of the source, which is not
 *  evidence at all. Most repositories worth pointing this at have no suite, so
 *  the no-suite path is the important one and gets the most cases here.
 *
 *  These run the real detectors against real temporary directories, including
 *  actually asking this machine whether it can run python3 and node. That is the
 *  point: a plan built from a manifest rather than from what the host can execute
 *  fails later, as something that looks like a broken test.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { testPlanFor } from './testing.ts';

const repo = (files: Record<string, string>): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'plan-'));
  for (const [name, contents] of Object.entries(files)) {
    const full = path.join(dir, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return dir;
};

test('a python project with no tests gets a runner and a place to put them', async () => {
  const dir = repo({ 'src/convert.py': 'def convert(x):\n    return x\n' });

  const plan = await testPlanFor(dir);
  assert.ok(plan, 'a python project is always testable — python3 is how it runs');
  assert.equal(plan.language, 'python');
  assert.equal(plan.origin, 'established', 'it had no suite, so this plan is the convention being introduced');
  // A place, and a naming rule strict enough that the runner will collect it.
  assert.match(plan.place.dir, /tests?$/);
  assert.match(plan.place.naming, /test_/);
  assert.ok(plan.only, 'a single new test file can be run on its own');
});

test("a python project's existing suite is used rather than replaced", async () => {
  const dir = repo({
    'src/convert.py': 'def convert(x):\n    return x\n',
    'tests/test_convert.py': 'def test_convert():\n    assert True\n',
  });

  const plan = await testPlanFor(dir);
  assert.ok(plan);
  assert.equal(plan.origin, 'project');
  assert.equal(plan.place.dir, 'tests');
});

test('a monorepo\'s own test directory is found, not a guess at the root', async () => {
  const dir = repo({
    'packages/markitdown/src/markitdown/convert.py': 'x = 1\n',
    'packages/markitdown/tests/test_convert.py': 'def test_ok():\n    assert True\n',
  });

  const plan = await testPlanFor(dir);
  assert.ok(plan);
  assert.equal(plan.place.dir, path.join('packages', 'markitdown', 'tests'));
  assert.equal(plan.origin, 'project');
});

test('a placeholder npm test script is not a test suite', async () => {
  // `npm init` writes exactly this, and treating it as the project's suite makes
  // every baseline red for a reason that has nothing to do with the code.
  const dir = repo({
    'package.json': JSON.stringify({
      name: 'thing',
      scripts: { test: 'echo "Error: no test specified" && exit 1' },
    }),
    'index.js': 'export const add = (a, b) => a + b;\n',
  });

  const plan = await testPlanFor(dir);
  assert.ok(plan);
  assert.equal(plan.language, 'javascript');
  assert.equal(plan.origin, 'established');
  assert.equal(plan.suite.cmd, 'node');
  assert.deepEqual(plan.suite.args.slice(0, 1), ['--test'], "node's own runner needs nothing installed");
  assert.match(plan.place.naming, /\.test\.js/, 'the naming is what makes node --test collect it');
});

test('a directory with no source at all is the one honest refusal', async () => {
  // Nothing to run, and nothing a test could be written against. Reported as a
  // fact about the host rather than as a shrug.
  const dir = repo({ 'README.md': '# docs only\n' });
  assert.equal(await testPlanFor(dir), null);
});
