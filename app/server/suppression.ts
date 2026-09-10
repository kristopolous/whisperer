/** Why a source is empty.
 *
 *  The coverage grid can show that X has nothing from the last three months.
 *  It cannot say why, and the four reasons it might be are not remotely
 *  equivalent:
 *
 *    - nobody posted anything, which is a fact about the world
 *    - we never issued a query for it, which is a gap in the query list
 *    - the query came back empty, which says the provider does not index it
 *    - it came back and we threw it away, which is our own filters eating it
 *
 *  The last one is the common case and the invisible one. X serves a login wall
 *  to anything that is not a browser, so its results arrive with a title and no
 *  usable snippet; the relevance filter then drops them for not naming the
 *  company, which is true of the login wall and false of the post behind it.
 *  From outside, that is indistinguishable from X having gone quiet, and it is
 *  the difference between "our reputation is fine there" and "we are blind
 *  there".
 *
 *  So every drop is counted against the source it came from, the stage that
 *  made the decision, and the reason, with a handful of the actual URLs, so a
 *  filter that is eating good material can be recognised as such by looking at
 *  what it ate.
 *
 *  Keyed on the run rather than passed through every signature, for the same
 *  reason cancellation is: the pipeline's functions take a corpus and a log
 *  callback, and threading an audit object through all of them would put the
 *  bookkeeping into the signature of the work.
 */

import type { Drop, Stage, VenueAudit } from '../shared/types.ts';
import { currentRun } from './run-context.ts';
import { venueOf } from './search.ts';

/** Twelve examples per reason, because the point is to be able to tell a filter
 *  working from a filter misfiring, and three URLs is not enough to tell. They
 *  cost nothing to keep. */
const EXAMPLES_PER_REASON = 12;

interface RunLedger {
  returned: Map<string, number>;
  seen: Map<string, Set<string>>;
  drops: Map<string, Drop>;
}

const ledgers = new Map<string, RunLedger>();

const ledgerFor = (scanId: string): RunLedger => {
  let ledger = ledgers.get(scanId);
  if (!ledger) {
    ledger = { returned: new Map(), seen: new Map(), drops: new Map() };
    ledgers.set(scanId, ledger);
  }
  return ledger;
};

const current = (): RunLedger | null => {
  const scanId = currentRun()?.scanId;
  return scanId ? ledgerFor(scanId) : null;
};

/** Everything search returned, before anything judged it.
 *
 *  Deduplicated by URL, because the same result arriving from four providers is
 *  one thing the internet holds, not four, and a `returned` count inflated by
 *  provider overlap would make a venue look covered when one page was found
 *  repeatedly. */
export function retrieved(url: string): void {
  const ledger = current();
  if (!ledger) return;
  const venue = venueOf(url);
  let seen = ledger.seen.get(venue);
  if (!seen) {
    seen = new Set();
    ledger.seen.set(venue, seen);
  }
  if (seen.has(url)) return;
  seen.add(url);
  ledger.returned.set(venue, (ledger.returned.get(venue) ?? 0) + 1);
}

/** One result removed, and why.
 *
 *  Called at the point of the decision rather than inferred from before/after
 *  counts. A count difference tells you nine things vanished; it cannot tell
 *  you which filter took them, and that is the only part worth knowing. */
export function dropped(hit: { url: string; title?: string }, reason: string, stage?: Stage): void {
  const ledger = current();
  if (!ledger) return;
  const venue = venueOf(hit.url);
  const at = stage ?? currentRun()?.stage ?? 'unknown';
  const key = `${venue} ${at} ${reason}`;

  let drop = ledger.drops.get(key);
  if (!drop) {
    drop = { stage: at, reason, count: 0, examples: [] };
    ledger.drops.set(key, drop);
  }
  drop.count += 1;
  if (drop.examples.length < EXAMPLES_PER_REASON) {
    drop.examples.push({ url: hit.url, title: (hit.title ?? '').slice(0, 140) });
  }
  // The venue must appear in the audit even if nothing about it was ever
  // counted as returned: a venue whose every result died before the merge still
  // has a story, and an absent row would tell none of it.
  if (!ledger.returned.has(venue)) ledger.returned.set(venue, 0);
}

/** Count several drops at once, where the decision was made over a slice.
 *
 *  Volume caps are the case: `slice(0, n)` discards a tail, and the tail is a
 *  real suppression even though no per-item test was run on any of it. */
export function droppedAll(
  hits: { url: string; title?: string }[], reason: string, stage?: Stage,
): void {
  for (const hit of hits) dropped(hit, reason, stage);
}

/** What this run suppressed, per source. */
export function audit(scanId: string): VenueAudit[] {
  const ledger = ledgers.get(scanId);
  if (!ledger) return [];

  const venues = new Set([...ledger.returned.keys()]);
  for (const key of ledger.drops.keys()) venues.add(key.split(' ')[0]!);

  return [...venues].map((venue) => ({
    venue,
    returned: ledger.returned.get(venue) ?? 0,
    drops: [...ledger.drops.entries()]
      .filter(([key]) => key.split(' ')[0] === venue)
      .map(([, drop]) => drop)
      .sort((a, b) => b.count - a.count),
  })).sort((a, b) => a.venue.localeCompare(b.venue));
}
export function forgetRun(scanId: string): void {
  ledgers.delete(scanId);
}

/** Fold this process's accounting into what the scan already carries.
 *
 *  The ledger lives in memory and the scan does not, so a stage re-run in a
 *  fresh process starts with an empty ledger while the scan still holds a full
 *  audit from before. Assigning over it would erase every other stage's
 *  accounting to record one stage's — and the stages are independently
 *  re-runnable, which is the whole reason that matters.
 *
 *  So only the rows belonging to the stage that just ran are replaced. Its old
 *  rows describe a run that no longer exists; everything else still stands.
 */
export function mergeAudit(previous: VenueAudit[], fresh: VenueAudit[], stage: Stage): VenueAudit[] {
  const byVenue = new Map<string, VenueAudit>();

  for (const row of previous) {
    byVenue.set(row.venue, {
      venue: row.venue,
      returned: row.returned,
      drops: row.drops.filter((drop) => drop.stage !== stage),
    });
  }

  for (const raw of fresh) {
    // Only this stage's rows. `audit()` returns the whole run's ledger, so
    // without this every earlier stage's drops are re-appended each time a
    // later stage finishes — six stages after discovery meant every discovery
    // reason listed six times, each with the correct count, which reads as six
    // separate filters doing the same thing.
    const row = { ...raw, drops: raw.drops.filter((drop) => drop.stage === stage) };
    const existing = byVenue.get(row.venue);
    if (!existing) {
      if (row.returned === 0 && row.drops.length === 0) continue;
      byVenue.set(row.venue, row);
      continue;
    }
    // A stage that retrieves nothing (scoring, say) must not zero a count that
    // discovery earned.
    if (row.returned > 0) existing.returned = row.returned;
    existing.drops = [...existing.drops.filter((drop) => drop.stage !== stage), ...row.drops];
  }

  return [...byVenue.values()]
    .filter((row) => row.returned > 0 || row.drops.length > 0)
    .map((row) => ({ ...row, drops: [...row.drops].sort((a, b) => b.count - a.count) }))
    .sort((a, b) => a.venue.localeCompare(b.venue));
}
