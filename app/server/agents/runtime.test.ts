/** What counts as worth one more try.
 *
 *  The distinction earns a test because getting it wrong is silent in both
 *  directions. Treating a permanent failure as flaky doubles the cost of every
 *  broken prompt; treating a flaky one as permanent drops a batch, and a dropped
 *  batch is two dozen mentions that were never scored under a one-line warning
 *  nobody reads twice.
 *
 *  It used to be decided by recognising the wording of V8's JSON errors, which
 *  covered the class only as far as somebody had met it — a real run lost a buzz
 *  batch to "Expected ':' after property name", which nobody had written down.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { isFlaky } from './runtime.ts';

test('every JSON syntax error is worth one more try', () => {
  // The exact shapes seen in real runs, produced rather than typed, so this
  // stays true when V8 rephrases them.
  const malformed = [
    '{"index": 0, "sentiment" "negative"}',        // the missing colon
    '{"issues": [{"title": "a"',                    // stopped mid-answer
    '{"score": 0.5,}',                              // trailing comma
    'not json at all',
    '{"text": "he said "hi" and left"}',            // unescaped quotes
  ];
  for (const raw of malformed) {
    let thrown: unknown;
    try {
      JSON.parse(raw);
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown, `${raw} should not parse`);
    assert.equal(isFlaky(thrown), true, (thrown as Error).message);
  }
});

test('a reply that never arrived, or a connection that dropped, is worth one more try', () => {
  for (const message of [
    'model returned an empty response',
    'no JSON in model output: I cannot help with that',
    'fetch failed',
    'read ECONNRESET',
    'socket hang up',
  ]) {
    assert.equal(isFlaky(new Error(message)), true, message);
  }
});

test('a request that is wrong is not retried', () => {
  // These fail identically every time, so a second attempt is a minute of model
  // time spent to learn nothing.
  for (const message of [
    'model endpoint 401: invalid api key',
    'model endpoint 400: context length exceeded',
    'cannot tell how to run tests in /repo — refusing to claim a fix works',
    'no such issue',
  ]) {
    assert.equal(isFlaky(new Error(message)), false, message);
  }
});
