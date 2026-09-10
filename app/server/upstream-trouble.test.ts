/** The breaker exists to stop a dead host costing two hours of "running".
 *
 *  What it must NOT do is turn a flaky host into a failed stage: a host that
 *  answers two batches in three is degraded, and grinding through that is the
 *  right call. So both directions are tested — giving up on a wall of identical
 *  failures, and not giving up when anything succeeds in between.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { UpstreamTrouble } from './upstream-trouble.ts';

const engineError = (at: number) =>
  new SyntaxError(`Unexpected token 'e', ..." "same": [engine err"... is not valid JSON at position ${at}`);

test('gives up once the failures are clearly about the host', () => {
  const said: string[] = [];
  const trouble = new UpstreamTrouble('complaint triage', (_level, text) => said.push(text));

  // The byte offset differs every time, which is why the signature normalises
  // digits: without that these read as three unrelated errors and the loop
  // grinds on through all 265 batches.
  trouble.record(engineError(436));
  trouble.record(engineError(1898));
  assert.equal(said.length, 2, 'the first two are reported and survived');

  assert.throws(() => trouble.record(engineError(77)), (error: Error) => {
    assert.match(error.message, /3 batches in a row failed the same way/);
    assert.match(error.message, /this is the service and not the data/);
    // Names the real cause rather than the parser it surfaced through.
    assert.match(error.message, /inference host failed mid-response/);
    return true;
  });
});

test('a success resets it, so a degraded host is not treated as a dead one', () => {
  const trouble = new UpstreamTrouble('feed triage', () => {});
  trouble.record(engineError(1));
  trouble.record(engineError(2));
  trouble.ok();
  trouble.record(engineError(3));
  trouble.record(engineError(4));
  // Four failures, and it keeps going: one batch in three came back.
  assert.equal(trouble.failures, 4);
});

test('unrelated failures do not accumulate into a verdict about the host', () => {
  const trouble = new UpstreamTrouble('subject check', () => {});
  trouble.record(new Error('fetch failed'));
  trouble.record(new Error('model returned no verdict array'));
  // Three different faults are three problems with the work, not one with the
  // service, and giving up on them would hide three separate bugs behind one
  // misleading message.
  assert.doesNotThrow(() => trouble.record(new Error('timed out after 180000ms')));
});
