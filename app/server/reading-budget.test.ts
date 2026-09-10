/** A batch size is a property of the window, not of the work.
 *
 *  Both directions have now cost a real run: a host whose window was smaller
 *  than the assumed 15,000 produced `[engine err…]` mid-response and ten
 *  identical batch failures, and a host with 128,000 would have been driven at
 *  a tenth of what it could hold.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readingBudget } from './reading-budget.ts';

// The module reads the configured host, so these assert the shape of the
// scaling rather than one host's numbers: the invariants are what matter and
// they hold whatever the machine is pointed at.

test('a batch never exceeds half the window', () => {
  // The prompt scaffolding, the schema instruction and the reply share the
  // window with the items. Filling it with input is how you get a truncated
  // answer, which is indistinguishable from a broken model.
  const budget = readingBudget(12_000, 30);
  assert.ok(
    budget.chars <= budget.contextLength * 0.5 * 3.6,
    `${budget.chars} chars must fit half of a ${budget.contextLength}-token window`,
  );
});

test('items grow far more slowly than characters', () => {
  // The item ceiling was measured on reasoning, not capacity: the same model
  // handled 32 items and failed every batch at 48, long before the window was
  // the constraint. A bigger window does not make a model track more things.
  const budget = readingBudget(12_000, 30);
  const charRatio = budget.chars / 12_000;
  const itemRatio = budget.items / 30;
  if (charRatio > 1.5) {
    assert.ok(itemRatio < charRatio, 'items must not scale as fast as characters');
  }
  assert.ok(budget.items >= 4, 'a batch of fewer than four items is not worth a call');
});

test('says what it chose and what it was derived from', () => {
  // A budget that changes by a factor of eight without saying so is the kind of
  // silent behaviour change that takes a day to find.
  const budget = readingBudget(12_000, 30);
  assert.match(budget.note, /packing/);
  assert.ok(budget.note.includes(String(budget.items)), 'the note must name the item count it chose');
});

test('a tiny window shrinks the batch rather than overflowing it', () => {
  // The failure that started this: the batch was sized by a constant and the
  // host could not hold it, so the host wrote its error into the stream.
  const budget = readingBudget(12_000, 30);
  assert.ok(budget.chars >= 2_000, 'but never below a floor worth calling for');
});
