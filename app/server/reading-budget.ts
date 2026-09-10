/** How much text one model call may carry, given the host actually configured.
 *
 *  The batch sizes in the pipeline were measured, carefully, against one model
 *  on one host — and then frozen as constants. That was fine for exactly as
 *  long as the host did not change. It changed twice in an afternoon: first to
 *  a model whose window was SMALLER than the 15,000 assumed by default, which
 *  is what produced `[engine err…]` spliced into the middle of a response and
 *  ten identical batch failures; then to one with 128,000, against which the
 *  same constants read about a tenth of what the call could hold.
 *
 *  Both failures are the same mistake. A batch size is not a property of the
 *  work, it is a property of the window it has to fit in, and hard-coding it
 *  means every host change is either a crash or a silent eight-fold waste.
 *
 *  So the character budget scales with the host's context. Two things do NOT
 *  scale with it, deliberately:
 *
 *  - **The item ceiling.** The measurement that set it was about reasoning, not
 *    capacity: the same model on the same corpus handled 32 items and failed
 *    every batch at 48, long before the window was the constraint. A model
 *    given a hundred things to judge at once starts skipping them, and a
 *    bigger window does not fix that. Raised somewhat with the window, since a
 *    larger model usually does track more, but nowhere near proportionally.
 *
 *  - **The reply.** Output is bounded by `maxOutputTokens`, and a verdict per
 *    item has to fit in it. Packing input until the context is full while the
 *    answer is truncated produces the exact failure this file exists to stop.
 */

import { resolveEndpoint } from './model.ts';

/** The window the constants in the pipeline were measured against. Everything
 *  here is expressed as a ratio to it, so the tuned numbers stay the tuned
 *  numbers on a host of that size. */
const REFERENCE_CONTEXT = 15_000;

/** Roughly how many characters a token is worth in English prose. Used only to
 *  keep the budget honest against the window; nothing here needs a real
 *  tokeniser, and a wrong-by-20% estimate is harmless when the budget is a
 *  fraction of the window anyway. */
const CHARS_PER_TOKEN = 3.6;

/** Never pack past this share of the window.
 *
 *  The prompt scaffolding, the schema instruction and the reply all live in the
 *  same window as the items. Half is the share the measured constants worked
 *  out to at 15,000, and keeping that share is what makes this a scaling of a
 *  known-good number rather than a fresh guess. */
const SHARE_OF_WINDOW = 0.5;

export interface ReadingBudget {
  /** Characters of item text one batch may carry. */
  chars: number;
  /** Items one batch may carry, whatever the characters say. */
  items: number;
  /** The host's window, for saying out loud what this was derived from. */
  contextLength: number;
  /** One line naming what was chosen and why, for the run log. A budget that
   *  changes by a factor of eight without saying so is the kind of silent
   *  behaviour change that takes a day to find. */
  note: string;
}

/** Scale a measured batch size to the configured host.
 *
 *  `baseChars` and `baseItems` are the numbers measured at REFERENCE_CONTEXT,
 *  kept in the pipeline next to the measurement that produced them. */
export function readingBudget(baseChars: number, baseItems: number): ReadingBudget {
  let contextLength = REFERENCE_CONTEXT;
  try {
    contextLength = resolveEndpoint('general').contextLength;
  } catch {
    // No host configured is not this module's problem to report: the call that
    // follows will say so far more clearly than a budget could.
  }

  const ratio = Math.max(0.25, contextLength / REFERENCE_CONTEXT);

  // The window is the hard ceiling; the scaled measurement is the soft one.
  // Whichever is smaller wins, so a small host shrinks the batch rather than
  // overflowing it — which is the case that produced the engine errors.
  const windowChars = Math.floor(contextLength * SHARE_OF_WINDOW * CHARS_PER_TOKEN);
  const chars = Math.max(2_000, Math.min(Math.round(baseChars * ratio), windowChars));

  // Items grow with the square root of the ratio: 8x the window buys under 3x
  // the items, because the limit on items was never the window.
  const items = Math.max(4, Math.round(baseItems * Math.sqrt(ratio)));

  const note = contextLength === REFERENCE_CONTEXT
    ? `packing ${items} items / ${chars.toLocaleString()} chars per call`
    : `packing for a ${contextLength.toLocaleString()}-token window: ${items} items / `
      + `${chars.toLocaleString()} chars per call `
      + `(measured at ${baseItems}/${baseChars.toLocaleString()} on ${REFERENCE_CONTEXT.toLocaleString()})`;

  return { chars, items, contextLength, note };
}
