/** The store's concurrency rules, which are the easy ones to break.
 *
 *  Everything here is about one situation: a stage handler holds a scan object
 *  for minutes while a model works, and short request handlers change fields on
 *  the same scan in the meantime. Whether those changes survive comes down to
 *  object identity — invisible in the types, easy to lose to an innocent-looking
 *  spread, and silent when it breaks. Hence tests.
 *
 *  Run with `npm test`.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Scan } from '../shared/types.ts';

// Point the store at a throwaway file before it is imported — it reads on load
// and writes on every change, and neither belongs in the real data directory.
const dir = mkdtempSync(path.join(tmpdir(), 'whisperer-store-'));
const file = path.join(dir, 'scans.json');
writeFileSync(file, '[]');
process.env.WHISPERER_SCANS = file;

const store = await import('./store.ts');

const blank = (id: string): Scan => ({
  id, input: 'x', company: 'X', site: 'x.com', createdAt: new Date().toISOString(),
  status: 'running', stage: 'queued', profiles: [], mentions: [], issues: [], abuse: [],
  buzz: [], topics: [], migrations: [], reviews: [], feed: [], log: [], timings: {},
  verdict: '', net: { now: 0, delta: 0 },
} as unknown as Scan);

test('a patch during a long run is not reverted when the run persists', () => {
  store.put(blank('a'));

  const held = store.get('a')!;               // what a stage handler is holding
  held.mentions = [{ url: 'u' } as never];    // ...and filling in, slowly

  store.patch('a', { reviews: [{ site: 'g2' } as never] });  // a request, meanwhile
  assert.equal(held.reviews.length, 1, 'the patch must reach the object the run holds');

  store.put(held);                            // the run reaches a stage boundary
  assert.equal(store.get('a')!.reviews.length, 1, 'the run must not revert the patch');
  assert.equal(store.get('a')!.mentions.length, 1, 'the run must keep its own work');
});

test('a scan marked failed stays failed', () => {
  store.put(blank('b'));
  const held = store.get('b')!;
  store.patch('b', { status: 'error', error: 'boom' });
  store.put(held);
  assert.equal(store.get('b')!.status, 'error');
});

test('there is one object per scan, and patch hands it back', () => {
  store.put(blank('c'));
  const held = store.get('c')!;
  assert.equal(store.patch('c', { verdict: 'v' }), held);
  assert.equal(store.get('c'), held);
});

test('put still replaces a whole record, for a genuine re-run', () => {
  store.put(blank('d'));
  store.patch('d', { status: 'error', error: 'boom' });
  store.put(blank('d'));
  assert.equal(store.get('d')!.error, undefined, 'a fresh run must not inherit the old failure');
  assert.equal(store.get('d')!.mentions.length, 0);
});

test('the write lock admits one holder', () => {
  assert.equal(store.claim('e', 'full scan').ok, true);
  const second = store.claim('e', 'feed rerun');
  assert.equal(second.ok, false);
  assert.equal(second.ok === false && second.held.what, 'full scan');

  store.release('e', 'feed rerun');                       // not the holder
  assert.equal(store.claim('e', 'another').ok, false, 'a non-holder must not release the lock');

  store.release('e', 'full scan');
  assert.equal(store.claim('e', 'later').ok, true);
});

test('changes reach the file', () => {
  store.put(blank('f'));
  store.patch('f', { verdict: 'written' });
  const onDisk = JSON.parse(readFileSync(file, 'utf8')) as Scan[];
  assert.equal(onDisk.find((s) => s.id === 'f')?.verdict, 'written');
});

/* --------------------------------------------------------------- schedule */

test('nextRun lands on the configured hour and never in the past', async () => {
  const { nextRun } = await import('./schedule.ts');
  const entry = { id: 'a', input: 'bolt.new', cadence: 'daily' as const, hour: 6, enabled: true };

  const morning = new Date('2026-09-03T09:00:00');
  const next = nextRun(entry, morning);
  assert.equal(next.getHours(), 6);
  assert.ok(next > morning, 'must be in the future');
  assert.equal(next.getDate(), morning.getDate() + 1, '9am is past 6am, so tomorrow');

  const weekly = nextRun({ ...entry, cadence: 'weekly' }, morning);
  assert.equal(weekly.getHours(), 6);
  assert.ok(weekly > morning);
});

test('a schedule that already ran today waits for the next slot', async () => {
  const { nextRun } = await import('./schedule.ts');
  const entry = {
    id: 'a', input: 'bolt.new', cadence: 'daily' as const, hour: 6, enabled: true,
    lastRunAt: new Date('2026-09-03T06:00:30').toISOString(),
  };
  const next = nextRun(entry, new Date('2026-09-03T06:05:00'));
  assert.equal(next.getDate(), 4, 'not again the same morning');
});

/* ---------------------------------------------------------- reply links */

test('a reply links to the ticket and the fix, from what exists', async () => {
  const { followUpLinks } = await import('./agents/respond-to-user.ts');
  const issue = {
    id: 'x', filedTo: { tracker: 'github', ref: 'https://github.com/me/fork/issues/1', at: '' },
    loop: [
      { step: 'filed', ref: { label: '#1', url: 'https://github.com/me/fork/issues/1' } },
      { step: 'test-added', ref: { label: '#2', url: 'https://github.com/me/fork/pull/2' } },
    ],
  } as unknown as Parameters<typeof followUpLinks>[0];

  assert.deepEqual(followUpLinks(issue), [
    { label: 'The ticket', url: 'https://github.com/me/fork/issues/1' },
    { label: 'The fix', url: 'https://github.com/me/fork/pull/2' },
  ]);
});

test('a reply carries no link when nothing has been filed', async () => {
  const { followUpLinks } = await import('./agents/respond-to-user.ts');
  const bare = { id: 'x', loop: [] } as unknown as Parameters<typeof followUpLinks>[0];
  assert.deepEqual(followUpLinks(bare), []);

  // A ref that is "#1" or "pending" is not a URL and must never be printed as
  // one — filing records a ref before it knows the address.
  const pending = {
    id: 'x', filedTo: { tracker: 'github', ref: 'pending', at: '' },
    loop: [{ step: 'filed', ref: { label: '#1' } }],
  } as unknown as Parameters<typeof followUpLinks>[0];
  assert.deepEqual(followUpLinks(pending), []);
});

/* ------------------------------------------------------ patch verification */

test('a patch is only trustworthy when the new test fails without it', async () => {
  const { verifyPatch } = await import('./verify.ts');
  const { mkdtempSync, writeFileSync: write, mkdirSync: mkdir } = await import('node:fs');
  const os = await import('node:os');
  const pathmod = await import('node:path');

  // A tiny repo whose "suite" is a script that imports the module.
  const repo = mkdtempSync(pathmod.join(os.tmpdir(), 'verify-'));
  mkdir(pathmod.join(repo, 'tests'), { recursive: true });
  write(pathmod.join(repo, 'lib.py'), 'def add(a, b):\n    return a - b\n');
  write(pathmod.join(repo, 'tests/test_lib.py'), 'from lib import add\n\ndef test_nothing():\n    assert True\n');
  const cmd = { cmd: 'python3', args: ['-m', 'pytest', 'tests/', '-q'] };

  // A real fix plus a test that catches the bug.
  const good = await verifyPatch(repo, [
    { path: 'lib.py', contents: 'def add(a, b):\n    return a + b\n' },
    { path: 'tests/test_lib.py', contents: 'from lib import add\n\ndef test_adds():\n    assert add(2, 2) == 4\n' },
  ], cmd);
  assert.equal(good.passed, true);
  assert.equal(good.provesTheBug.failedOnOriginal, true);
  assert.equal(good.trustworthy, true);

  // The same fix with a test that asserts nothing. Green either way, and that
  // is exactly the patch this check exists to refuse.
  const hollow = await verifyPatch(repo, [
    { path: 'lib.py', contents: 'def add(a, b):\n    return a + b\n' },
    { path: 'tests/test_lib.py', contents: 'def test_hollow():\n    assert True\n' },
  ], cmd);
  assert.equal(hollow.passed, true, 'the suite is green');
  assert.equal(hollow.provesTheBug.failedOnOriginal, false);
  assert.equal(hollow.trustworthy, false, 'green is not enough');
});

test('a patch cannot write outside the checkout', async () => {
  const { verifyPatch } = await import('./verify.ts');
  const { mkdtempSync } = await import('node:fs');
  const os = await import('node:os');
  const pathmod = await import('node:path');
  const repo = mkdtempSync(pathmod.join(os.tmpdir(), 'verify-esc-'));
  await assert.rejects(
    () => verifyPatch(repo, [{ path: '../../escaped.txt', contents: 'no' }], { cmd: 'true', args: [] }),
    /outside the checkout/,
  );
});

test('the rail points at the live run, not a stale failed one', () => {
  // The case from a real session: a Replit rescan reached 1,590 mentions while
  // the sidebar kept pointing at an errored attempt from a week earlier, so
  // every panel opened stale and the rescan looked like it had never started.
  const failed = { ...blank('aaaaaaaa'), company: 'Replit', site: 'https://replit.com/',
    status: 'error' as const, createdAt: '2026-09-02T08:14:00.000Z',
    mentions: Array.from({ length: 1586 }, (_, i) => ({ url: `https://a/${i}` } as never)) };
  const running = { ...blank('bbbbbbbb'), company: 'Replit', site: 'https://replit.com/',
    status: 'running' as const, createdAt: '2026-09-06T01:24:00.000Z',
    mentions: Array.from({ length: 1590 }, (_, i) => ({ url: `https://b/${i}` } as never)) };

  store.put(failed);
  store.put(running);
  const rows = store.list().filter((s) => s.company === 'Replit');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.id, 'bbbbbbbb');
});

test('a running scan with nothing yet still loses to a finished one', () => {
  // The case the old rule was aimed at, and it stays correct: for the first
  // half-minute there is genuinely nothing to show.
  const done = { ...blank('cccccccc'), company: 'Acme', site: 'https://acme.test/',
    status: 'done' as const, createdAt: '2026-09-01T00:00:00.000Z',
    mentions: [{ url: 'https://acme.test/x' } as never] };
  const starting = { ...blank('dddddddd'), company: 'Acme', site: 'https://acme.test/',
    status: 'running' as const, createdAt: '2026-09-08T00:00:00.000Z' };

  store.put(done);
  store.put(starting);
  const rows = store.list().filter((s) => s.company === 'Acme');
  assert.equal(rows[0]?.id, 'cccccccc');
});
