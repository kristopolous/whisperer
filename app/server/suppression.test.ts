/** The accounting has to survive a partial re-run, which is the only hard part.
 *
 *  Stages are independently re-runnable and the ledger is in memory, so a run
 *  that re-does discovery in a fresh process holds no record of what feed or
 *  buzz suppressed last time — while the scan still does. Getting that wrong in
 *  either direction produces a panel that lies: overwrite and every other
 *  stage's reasons vanish, merge naively and a stale reason from a filter that
 *  no longer exists is reported as current.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { VenueAudit } from '../shared/types.ts';
import { withRunContext } from './run-context.ts';
import { audit, dropped, droppedAll, forgetRun, mergeAudit, retrieved } from './suppression.ts';
import { engineFailure } from './errors.ts';

const inRun = (scanId: string, stage: 'discovery' | 'feed', fn: () => void) =>
  withRunContext({ scanId, stage }, fn);

test('separates what came back from what we threw away', () => {
  const id = 'audit-1';
  forgetRun(id);

  inRun(id, 'discovery', () => {
    for (const n of [1, 2, 3]) retrieved(`https://x.com/someone/status/${n}`);
    retrieved('https://reddit.com/r/thing/comments/a');
    dropped({ url: 'https://x.com/someone/status/1', title: 'Sign in to X' }, 'nothing names it');
    dropped({ url: 'https://x.com/someone/status/2', title: 'Sign in to X' }, 'nothing names it');
    dropped({ url: 'https://x.com/someone/status/3', title: 'X' }, 'a site front page');
  });

  const rows = audit(id);
  const x = rows.find((row) => row.venue === 'x')!;

  // Three came back and three were dropped: the venue is empty because of us.
  assert.equal(x.returned, 3);
  assert.equal(x.drops.reduce((sum, drop) => sum + drop.count, 0), 3);
  // Ordered by size, because the biggest filter is the one worth looking at.
  assert.equal(x.drops[0]?.reason, 'nothing names it');
  assert.equal(x.drops[0]?.count, 2);
  assert.equal(x.drops[0]?.stage, 'discovery');
  assert.deepEqual(x.drops[0]?.examples.map((e) => e.title), ['Sign in to X', 'Sign in to X']);

  // Reddit returned one and lost none. Its row exists and says so.
  assert.equal(rows.find((row) => row.venue === 'reddit')?.returned, 1);
  assert.equal(rows.find((row) => row.venue === 'reddit')?.drops.length, 0);
});

test('the same URL from four providers is one result, not four', () => {
  const id = 'audit-2';
  forgetRun(id);
  inRun(id, 'discovery', () => {
    for (let i = 0; i < 4; i += 1) retrieved('https://news.ycombinator.com/item?id=1');
  });
  // Otherwise provider overlap makes a thin venue look well covered.
  assert.equal(audit(id).find((row) => row.venue === 'hackernews')?.returned, 1);
});

test('a cap is recorded as a suppression like any other', () => {
  const id = 'audit-3';
  forgetRun(id);
  inRun(id, 'discovery', () => {
    droppedAll(
      [{ url: 'https://reddit.com/r/a/comments/1' }, { url: 'https://reddit.com/r/a/comments/2' }],
      'over the 5000-mention corpus cap',
    );
  });
  const reddit = audit(id).find((row) => row.venue === 'reddit')!;
  // Nothing was wrong with these. They lost a race against a number, and that
  // is exactly the kind of drop that is invisible without being counted.
  assert.equal(reddit.drops[0]?.count, 2);
  assert.equal(reddit.returned, 0);
});

test('a venue whose every result died still gets a row', () => {
  const id = 'audit-4';
  forgetRun(id);
  inRun(id, 'feed', () => {
    dropped({ url: 'https://x.com/a/status/9' }, 'a sign-in wall');
  });
  // An absent row reads as "we did not look there", which is a different and
  // much less alarming statement than "everything we found there was dropped".
  assert.deepEqual(audit(id).map((row) => row.venue), ['x']);
});

test('re-running one stage replaces its rows and leaves the others alone', () => {
  const previous: VenueAudit[] = [
    {
      venue: 'x',
      returned: 3,
      drops: [
        { stage: 'discovery', reason: 'old discovery reason', count: 3, examples: [] },
        { stage: 'feed', reason: 'a sign-in wall', count: 5, examples: [] },
      ],
    },
    { venue: 'reddit', returned: 40, drops: [{ stage: 'feed', reason: 'sidebar', count: 2, examples: [] }] },
  ];

  const fresh: VenueAudit[] = [
    { venue: 'x', returned: 9, drops: [{ stage: 'discovery', reason: 'new discovery reason', count: 9, examples: [] }] },
  ];

  const merged = mergeAudit(previous, fresh, 'discovery');
  const x = merged.find((row) => row.venue === 'x')!;

  // The re-run stage's old reason is gone: it describes a run that no longer
  // exists, and reporting it as current is how a fixed filter keeps being
  // blamed.
  assert.equal(x.drops.find((drop) => drop.reason === 'old discovery reason'), undefined);
  assert.equal(x.drops.find((drop) => drop.reason === 'new discovery reason')?.count, 9);
  // The feed's accounting is untouched — feed did not run.
  assert.equal(x.drops.find((drop) => drop.stage === 'feed')?.count, 5);
  assert.equal(x.returned, 9);

  // A venue absent from the fresh run keeps everything it had.
  assert.equal(merged.find((row) => row.venue === 'reddit')?.returned, 40);
  assert.equal(merged.find((row) => row.venue === 'reddit')?.drops.length, 1);
});

test('a stage that retrieves nothing does not zero what discovery earned', () => {
  const previous: VenueAudit[] = [{ venue: 'reddit', returned: 40, drops: [] }];
  const fresh: VenueAudit[] = [
    { venue: 'reddit', returned: 0, drops: [{ stage: 'buzz', reason: 'over the read budget', count: 4, examples: [] }] },
  ];
  const merged = mergeAudit(previous, fresh, 'buzz');
  assert.equal(merged[0]?.returned, 40);
  assert.equal(merged[0]?.drops[0]?.count, 4);
});

test('an engine failure is reported as the host, not as bad JSON', () => {
  // The real message, from a host that streamed half an object and then wrote
  // its own error into the stream. Blaming the parser sends whoever reads it to
  // debug code that is working.
  const error = new SyntaxError(`Unexpected token 'e', ..." "same": [engine err"... is not valid JSON`);
  const said = engineFailure(error);
  assert.match(said ?? '', /inference host failed mid-response/);
  assert.match(said ?? '', /not the response parser/);

  // An ordinary malformed response is not an engine failure and must not be
  // reported as one.
  assert.equal(engineFailure(new SyntaxError('Unexpected end of JSON input')), null);
});

test('a later stage does not re-append an earlier stage\'s drops', () => {
  // Measured on a real run: every discovery reason appeared five times over,
  // each with the correct count, which reads as five separate filters doing the
  // same thing. `audit()` returns the whole run, so the fresh side has to be
  // narrowed to the stage that just finished.
  const wholeRun: VenueAudit[] = [
    {
      venue: 'x',
      returned: 10,
      drops: [
        { stage: 'discovery', reason: 'older than 2026-03', count: 5, examples: [] },
        { stage: 'feed', reason: 'a sign-in wall', count: 3, examples: [] },
      ],
    },
  ];

  // Discovery already recorded; now feed finishes and hands over the whole
  // ledger again.
  let merged = mergeAudit([], wholeRun, 'discovery');
  merged = mergeAudit(merged, wholeRun, 'feed');

  const reasons = merged[0]!.drops.map((drop) => drop.reason);
  assert.deepEqual(
    [...reasons].sort(),
    ['a sign-in wall', 'older than 2026-03'],
    'each reason exactly once',
  );
});
