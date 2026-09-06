/** What each search provider has left, and what it has already cost.
 *
 *  Retrieval is the expensive part of this product. Every provider in the
 *  search chain arrived with a different free allowance — you.com 5,000 units,
 *  Parallel $20 of introductory credit, Andi $5, Brave 2,000 queries a month —
 *  and while the thing is being demoed those grants are the entire budget. The
 *  chain therefore needs to know which of them still has headroom, and the
 *  person running it needs to see the number without logging into four consoles.
 *
 *  Two units, deliberately, because the providers genuinely differ. Most bill
 *  per request and a count is the truth. Andi bills by outcome — "easy lookups
 *  cost less, hard-to-find content costs more" — and reports
 *  `metrics.cost_dollars` on every response, so for that one a request count
 *  would be a guess when an exact figure is being handed to us.
 *
 *  Spend accumulates across runs and is persisted. A per-run tally answers "how
 *  much did this scan cost", which is interesting; only a running total answers
 *  "can I afford to run this again", which is the question.
 *
 *  Nothing here throttles a provider that has no recorded allowance. An unknown
 *  grant is not the same as a spent one, and refusing to search because nobody
 *  typed a number in would be the tool inventing a limit it was never given.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const FILE = path.resolve(import.meta.dirname, '../../data/credits.json');

export type CreditUnit = 'dollars' | 'requests';

export interface Ledger {
  /** How the provider counts. */
  unit: CreditUnit;
  /** The allowance, when it is known. Undefined means "nobody said", which is
   *  treated as unlimited rather than as zero. */
  granted?: number;
  /** Spent since the ledger was last reset, in `unit`. */
  spent: number;
  /** Most one run may spend here, in `unit`. Undefined means no per-run limit.
   *
   *  This is what spreads a scan across the free grants instead of emptying
   *  the smallest one. The chain stops at the first provider that answers, so
   *  whichever leads absorbs every query: one measured run put 231 requests
   *  through Parallel and none at all through you.com, which was sitting on
   *  4,447 free units. Quality decides the order; this decides how long the
   *  leader keeps the job before the next one takes over. */
  perRun?: number;
  /** When the grant was recorded, so a monthly allowance can be seen to be
   *  stale rather than silently believed. */
  grantedAt?: string;
  updatedAt?: string;
}

/** Defaults for the providers this app ships with, so the panel says something
 *  useful before anybody edits it. The numbers are what each provider advertises
 *  for a new account; the real balance is whatever the console says, which is
 *  why every one of them is editable. */
const DEFAULTS: Record<string, Ledger> = {
  // Sixty is roughly a quarter of what one measured run asked for, so Parallel
  // serves the queries where its ranking and its dates matter most and the
  // rest fall through to the larger free pools.
  parallel: { unit: 'requests', spent: 0, perRun: 60 },
  you: { unit: 'requests', spent: 0 },
  andi: { unit: 'dollars', spent: 0, perRun: 0.5 },
  brave: { unit: 'requests', spent: 0 },
  'bright-data': { unit: 'requests', spent: 0 },
};

let ledgers: Record<string, Ledger> = load();

function load(): Record<string, Ledger> {
  try {
    return { ...DEFAULTS, ...(JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, Ledger>) };
  } catch {
    return { ...DEFAULTS };
  }
}

function flush() {
  try {
    mkdirSync(path.dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(ledgers, null, 2));
  } catch {
    // Losing the ledger must never fail a scan. It is bookkeeping.
  }
}

const ledgerFor = (provider: string): Ledger =>
  (ledgers[provider] ??= { unit: 'requests', spent: 0 });

/** Record what a provider just cost.
 *
 *  Called from the search client on every paid request. `dollars` is passed
 *  only by providers that report it; everything else counts requests. */
export function noteSpend(provider: string, amount: { requests?: number; dollars?: number }): void {
  const ledger = ledgerFor(provider);
  const delta = ledger.unit === 'dollars' ? (amount.dollars ?? 0) : (amount.requests ?? 0);
  if (!delta) return;
  ledger.spent += delta;
  thisRun[provider] = (thisRun[provider] ?? 0) + delta;
  ledger.updatedAt = new Date().toISOString();
  flush();
}

/** What is left, or null when no allowance was ever recorded. */
export function remaining(provider: string): number | null {
  const ledger = ledgers[provider];
  if (!ledger || ledger.granted === undefined) return null;
  return Math.max(0, ledger.granted - ledger.spent);
}

/** Has this provider spent everything it was given?
 *
 *  False when the allowance is unknown — see the note at the top. The chain
 *  reads this to skip a provider rather than pay for a refusal, and skipping on
 *  a number nobody supplied would take a working provider out of service. */
export const outOfCredit = (provider: string): boolean => {
  const left = remaining(provider);
  return left !== null && left <= 0;
};

/* ------------------------------------------------------------ this run --
 *
 *  Kept separately from the lifetime tally because they answer different
 *  questions and are reset at different times: the ledger persists forever and
 *  says whether the account is alive, this says whether one provider has had
 *  its turn in the run currently going. */
let thisRun: Record<string, number> = {};

export const resetRunSpend = (): void => { thisRun = {}; };

export const runSpend = (): Record<string, number> => ({ ...thisRun });

/** Has this provider had its share of this run?
 *
 *  False when it has no per-run limit, which is most of them. */
export function spentItsTurn(provider: string): boolean {
  const cap = ledgers[provider]?.perRun;
  if (cap === undefined) return false;
  return (thisRun[provider] ?? 0) >= cap;
}

export const listCredits = (): (Ledger & { provider: string; remaining: number | null })[] =>
  Object.entries(ledgers).map(([provider, ledger]) => ({
    provider,
    ...ledger,
    remaining: remaining(provider),
  }));

/** Set or correct a provider's allowance.
 *
 *  `spent` is settable too, because the honest way to reconcile with a console
 *  that says something different is to type in what the console says rather
 *  than to trust a tally that has been drifting since the first dropped
 *  response. */
export function setLedger(
  provider: string,
  changes: { unit?: CreditUnit; granted?: number | null; spent?: number; perRun?: number | null },
): Ledger {
  const ledger = ledgerFor(provider);
  if (changes.unit) ledger.unit = changes.unit;
  if (changes.perRun === null) delete ledger.perRun;
  else if (typeof changes.perRun === 'number') ledger.perRun = changes.perRun;
  if (changes.granted === null) delete ledger.granted;
  else if (typeof changes.granted === 'number') {
    ledger.granted = changes.granted;
    ledger.grantedAt = new Date().toISOString();
  }
  if (typeof changes.spent === 'number') ledger.spent = Math.max(0, changes.spent);
  ledger.updatedAt = new Date().toISOString();
  flush();
  return ledger;
}
