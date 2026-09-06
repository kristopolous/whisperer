import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Scan } from '../shared/types.ts';

/** Scans are kept as one JSON file. The dashboard needs history across restarts,
 *  and at this volume a database would be ceremony.
 *
 *  Overridable so the tests can exercise the real module against a throwaway
 *  file. Testing a copy of this code would test the copy. */
const FILE = process.env.WHISPERER_SCANS
  ? path.resolve(process.env.WHISPERER_SCANS)
  : path.resolve(import.meta.dirname, '../../data/scans.json');

let scans: Scan[] = load();

function load(): Scan[] {
  let stored: Scan[];
  try {
    stored = JSON.parse(readFileSync(FILE, 'utf8')) as Scan[];
  } catch {
    return [];
  }

  // Nothing is running at process start, whatever the file says. A scan is
  // marked `running` for as long as its stream is open, so a restart mid-run —
  // a crash, a file watcher, someone closing the terminal — leaves a record
  // that claims to be in progress forever. It then sits at the top of the rail
  // with a spinner on it, and the stage rerun offers to resume a stream that
  // has been dead since last week.
  //
  // So say what actually happened: it was interrupted. The collected data is
  // kept, because a run that got through four stages is still worth reading.
  for (const scan of stored) {
    if (scan.status === 'running') {
      scan.status = 'error';
      scan.error ??= 'Interrupted — the server stopped while this run was in progress.';
      scan.errorKind ??= 'interrupted';
      scan.failedStage ??= scan.stage;
    }
  }
  return stored;
}

function flush() {
  mkdirSync(path.dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(scans, null, 2));
}

const TLD = /\.(com|co\.uk|co|org|net|io|dev|app|ai|me|us|xyz|site|news|blog|company|social)$/i;
const SECOND_LEVEL = /\.(co\.uk|com\.au|co\.nz|co\.in|com\.br|co\.jp|com\.mx|org\.uk|gov\.uk)$/i;

/** A canonical grouping key for a scan's subject, so "supabase", "supabase.com"
 *  and "https://www.supabase.com/" all collapse to the same company. Keyed off
 *  the resolved site when we have one, else the raw company string. */
export function companyKey(scan: Scan): string {
  // A fixture is its own company, whatever it is named after. It carries the
  // real company's name and site by design — it is built on top of a real
  // scan — so keying it normally makes it collide with that company, and its
  // always-current timestamp then wins the collision every time. The real run
  // disappears from the rail and hand-written numbers are shown in its place.
  if (scan.fixture) return `fixture:${scan.id}`;
  const source = (scan.site || scan.company || '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[/?#]/)[0].trim().toLowerCase();
  if (!source) return '';
  let host = source;
  if (SECOND_LEVEL.test(host)) host = host.replace(SECOND_LEVEL, '');
  else if (TLD.test(host)) host = host.replace(TLD, '');
  else host = host.split('.')[0];
  return host;
}

/** The runs index. Bodies are stripped — the sidebar only needs the headline
 *  numbers, and a scan carries hundreds of excerpts.
 *
 *  Collapses to one entry per company: a company is frequently re-scanned (or a
 *  scan crashes and is retried), so the dashboard should show the single, most
 *  recent useful run rather than a row per attempt. "supabase.com", "supabase"
 *  and a pasted URL all count as the same company. */
/** How much a run actually produced. The tiebreaker when choosing which of a
 *  company's attempts to show. */
const yield_ = (scan: Scan) =>
  (scan.mentions?.length ?? 0) + (scan.feed?.length ?? 0)
  + (scan.issues?.length ?? 0) + (scan.abuse?.length ?? 0);
// Profiles are deliberately not counted. A run that found the company's own
// accounts and then no discussion at all has produced nothing anyone opened
// this dashboard for, and letting a footprint rescue it puts an empty run at
// the top of the rail.

/** Pick the one run that represents a company.
 *
 *  Recency alone is the wrong rule and produced a visibly wrong answer: a
 *  settled run holding nothing at all beat a run with sixty mentions, purely
 *  for being newer. Somebody looking at their dashboard wants the run that
 *  found something, and an empty scan is a failed attempt whatever its status
 *  says.
 *
 *  So: a run that produced something always beats one that did not, and only
 *  then does recency decide. A still-running scan still loses to a finished
 *  one, because a half-written record is not the thing to show — but it wins
 *  over a finished empty one, since it may yet produce something and the empty
 *  one never will. */
function best(a: Scan, b: Scan): Scan {
  const empty = (scan: Scan) => yield_(scan) === 0;
  if (empty(a) !== empty(b)) return empty(a) ? b : a;
  if (!empty(a) && !empty(b)) {
    const settled = (scan: Scan) => scan.status !== 'running';
    if (settled(a) !== settled(b)) return settled(a) ? a : b;
  }
  return a.createdAt.localeCompare(b.createdAt) >= 0 ? a : b;
}

export const list = () => {
  const chosen = new Map<string, Scan>();
  for (const scan of scans) {
    const key = companyKey(scan);
    if (!key) continue;
    const current = chosen.get(key);
    chosen.set(key, current ? best(current, scan) : scan);
  }

  return [...chosen.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    // Fixtures sort to the bottom regardless of date. They are for looking at a
    // populated dashboard, not for reading, and the top of the list is where a
    // person looks for their most recent real run.
    .sort((a, b) => Number(Boolean(a.fixture)) - Number(Boolean(b.fixture)))
    .map(summarize);
};

/** The headline numbers for one scan, with the chatty bodies stripped. */
function summarize({ mentions, issues, abuse, log, ...rest }: Scan) {
  void log;
  return {
    ...rest,
    mentions: [],
    issues: [],
    abuse: [],
    log: [],
    counts: {
      mentions: mentions.length,
      // How many mentions carry a judgement. The sidebar shows a net sentiment
      // per run, and without this it cannot tell "neutral" from "never scored"
      // — so every failed scoring pass showed as a confident +0.00.
      scored: mentions.filter((m) => m.scored ?? (m.score !== 0 || m.sentiment !== 'neutral')).length,
      issues: issues.length,
      abuse: abuse?.length ?? 0,
      critical: (issues ?? []).filter((i) => i.severity === 'critical').length
        + (abuse ?? []).filter((a) => a.severity === 'critical').length,
    },
  };
}

export const get = (id: string) => scans.find((s) => s.id === id);

/** Every run of the same company, oldest first.
 *
 *  The rail collapses a company's runs to one row, which is right for choosing
 *  what to look at and wrong for everything else: the earlier runs are still
 *  there, and they are the only reason the current one means anything. This is
 *  how the series gets at them. */
export function history(id: string): Scan[] {
  const target = get(id);
  if (!target) return [];
  const key = companyKey(target);
  if (!key) return [target];
  return scans
    .filter((scan) => companyKey(scan) === key)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/* --------------------------------------------------------- one writer ---
 *
 *  A scan is written by whoever is running it, and a stage takes minutes. Two
 *  runs on the same scan at once do not interleave — they overwrite. Both
 *  handlers hold their own `Scan` object (a full run builds a fresh one; a
 *  stage rerun reads the stored one), each mutates its copy for as long as its
 *  stage takes, and each writes the whole record back at the end. The one that
 *  finishes last wins, and everything the other wrote in the meantime is gone.
 *
 *  That is not hypothetical: a still-running abuse pass finished after a stage
 *  rerun had collected a fresh review scorecard, wrote its minutes-old snapshot
 *  over it, and took the stage marker back to `feed` as well. From the outside
 *  it looks like the rerun silently did nothing.
 *
 *  Merging on write does not fix it — a stale snapshot carries stale values for
 *  every field, so field-level last-write-wins still reverts them. The only
 *  correct answer is that one scan has one writer, so the second caller is told
 *  what is already running instead of racing it.
 */
interface Claim { what: string; since: number }
const claims = new Map<string, Claim>();

/** Take the write lock for a scan, or return who already holds it. */
export function claim(id: string, what: string): { ok: true } | { ok: false; held: Claim } {
  const held = claims.get(id);
  if (held) return { ok: false, held };
  claims.set(id, { what, since: Date.now() });
  return { ok: true };
}

/** Release the write lock. Safe to call when it was never taken — a handler
 *  that failed to claim still runs its own cleanup. */
export function release(id: string, what: string) {
  if (claims.get(id)?.what === what) claims.delete(id);
}

/** How long the current holder has had it, for the message the loser gets. */
export const heldFor = (held: Claim) => Math.round((Date.now() - held.since) / 1000);

/** Write a whole scan record.
 *
 *  For creating a record, and for a run persisting the object it is building.
 *  To change a few fields on an existing scan, use `patch` — see the note
 *  there, because putting a snapshot you have been holding is how updates get
 *  lost. */
export function put(scan: Scan) {
  const index = scans.findIndex((s) => s.id === scan.id);
  if (index === -1) scans.unshift(scan);
  else scans[index] = scan;
  flush();
  return scan;
}

/** Delete a scan and every other attempt at the same company.
 *
 *  The sidebar collapses re-scans into one row per company, so a row does not
 *  stand for one record — removing only the scan behind it would make an older
 *  attempt at the same company pop straight back into the list, which reads as
 *  the delete having failed. What the row means is "this company", so that is
 *  what goes.
 *
 *  Returns the ids actually removed, so the caller can say what happened rather
 *  than claiming a single deletion.
 */
export function remove(id: string): string[] {
  const target = get(id);
  if (!target) return [];

  const key = companyKey(target);
  const doomed = scans.filter((scan) => scan.id === id || (key && companyKey(scan) === key));
  const ids = new Set(doomed.map((scan) => scan.id));

  scans = scans.filter((scan) => !ids.has(scan.id));
  flush();
  return [...ids];
}

/** Change some fields on a scan, in place.
 *
 *  In place, and this is the whole point of the function. There is one object
 *  per scan in memory and `get` hands it out, so a stage that has been running
 *  for four minutes is mutating the same object a request handler just read.
 *  That shared identity is what keeps them from clobbering each other, and
 *  spreading into a copy breaks it: the copy replaces the array slot, the long
 *  run keeps writing to the object it still holds, and the next `put(scan)` it
 *  does puts the pre-patch record back. The change disappears with no error
 *  anywhere — which is precisely the bug this used to have, since it was
 *  written as `put({ ...scan, ...changes })`.
 *
 *  So: assign onto the stored object and flush. Everyone holding it sees the
 *  change, and nobody's later write reverts it.
 *
 *  This is not a substitute for the write lock above. Two runs on one scan
 *  still must not overlap — field-level merging cannot fix a stale snapshot,
 *  because a stale snapshot has stale values for every field it touches. This
 *  fixes the smaller, commoner case: a short handler changing one thing while
 *  something long is in flight. */
export function patch(id: string, changes: Partial<Scan>) {
  const scan = get(id);
  if (!scan) return undefined;
  Object.assign(scan, changes);
  flush();
  return scan;
}
