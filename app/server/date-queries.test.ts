/** Searching a window by writing its dates into the query.
 *
 *  The point of this technique is that it does not depend on any provider
 *  supporting a date range, so the tests are about the strings: that they cover
 *  the window, that they carry the formats real pages actually print, and that
 *  a long window does not turn into hundreds of searches.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { dayStrings, monthStrings, windowQueries } from './date-queries.ts';

test('a day is offered in the formats pages actually print', () => {
  // The same day is written four ways across four sites, and a page carries
  // whichever its template chose.
  const out = dayStrings(new Date('2026-08-01T00:00:00Z'));
  assert.deepEqual(out, ['Aug 1, 2026', 'August 1, 2026', '1 August 2026', '2026-08-01']);
});

test('a short window is searched day by day', () => {
  const { queries, note } = windowQueries('Replit', ['x.com'], '2026-08-01', '2026-08-03');
  assert.match(note, /day by day/);
  // Three days, four formats each.
  assert.equal(queries.length, 12);
  assert.ok(queries.every((q) => q.startsWith('site:x.com Replit "')), queries[0]);
  assert.ok(queries.some((q) => q.includes('"Aug 2, 2026"')));
  // The operators ride along for the engines that read them; the quoted date
  // is what carries the ones that do not.
  assert.ok(queries.every((q) => q.endsWith('after:2026-08-01 before:2026-08-03')));
});

test('a long window is searched month by month, not day by day', () => {
  // Two years day-by-day would be nearly three thousand searches to fill one
  // band. The month phrase covers it nearly as well.
  const { queries, note } = windowQueries('Replit', ['x.com'], '2024-01-01', '2026-01-01');
  assert.match(note, /month by month/);
  assert.ok(queries.length < 100, `${queries.length} queries`);
  assert.ok(queries.some((q) => q.includes('"March 2024"')));
  assert.ok(queries.some((q) => q.includes('"Mar 2024"')));
});

test('every host gets the whole window', () => {
  const { queries } = windowQueries('Replit', ['x.com', 'reddit.com'], '2026-08-01', '2026-08-01');
  assert.equal(queries.filter((q) => q.startsWith('site:x.com')).length, 4);
  assert.equal(queries.filter((q) => q.startsWith('site:reddit.com')).length, 4);
});

test('a venue with no sites still gets the date phrases', () => {
  // Unscoped is still useful: the date phrase is doing most of the work, and a
  // venue we cannot name hosts for is exactly the one a general search has to
  // cover.
  const { queries, note } = windowQueries('Replit', [], '2026-08-01', '2026-08-01');
  assert.equal(queries.length, 4);
  assert.ok(queries.every((q) => q.startsWith('Replit "')));
  assert.match(note, /unscoped/);
});

test('an impossible window is refused rather than guessed at', () => {
  const back = windowQueries('Replit', [], '2026-08-10', '2026-08-01');
  assert.deepEqual(back.queries, []);
  assert.match(back.note, /unusable/);
  assert.deepEqual(windowQueries('Replit', [], 'not-a-date', '2026-08-01').queries, []);
});

test('month names are the ones a page would print', () => {
  assert.deepEqual(monthStrings(new Date('2026-09-15T00:00:00Z')), ['September 2026', 'Sep 2026']);
});
