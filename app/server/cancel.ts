/** Stopping a run that is already going.
 *
 *  A scan is minutes of work — hundreds of rate-paced searches and several
 *  model calls that each take a minute on a local endpoint. Until now there was
 *  no way to stop one: the only control was to wait, and the write lock made
 *  that literal, since a second run on the same scan is refused while the first
 *  holds it. Starting the wrong scan, or watching one grind through a provider
 *  that has run out of quota, meant sitting through it.
 *
 *  Cancellation is a signal rather than a kill. The work is spread across
 *  fetches, a rate-limit queue and model streams, and tearing that down midway
 *  would leave the scan half-written. So a cancelled run stops at the next
 *  checkpoint, keeps whatever it has already collected, and says it was
 *  cancelled — which is a different thing from failing, and must not be
 *  reported as one.
 *
 *  The signal is published on the run context (see agents/runtime.ts) so the
 *  slow paths can honour it without every function in between growing a
 *  parameter it does not otherwise care about.
 */

import { CancelledError } from './run-context.ts';

const running = new Map<string, AbortController>();

/** Begin a cancellable run, returning the signal for it. Replaces any previous
 *  controller for the same scan — the write lock means there should not be one,
 *  and if there is, the newer run is the one a person is watching. */
export function begin(scanId: string): AbortSignal {
  running.get(scanId)?.abort(new CancelledError());
  const controller = new AbortController();
  running.set(scanId, controller);
  return controller.signal;
}

export function end(scanId: string): void {
  running.delete(scanId);
}

/** Ask a run to stop. Returns false when nothing was running, so the caller can
 *  say "there was nothing to cancel" rather than claiming success. */
export function cancel(scanId: string): boolean {
  const controller = running.get(scanId);
  if (!controller) return false;
  controller.abort(new CancelledError());
  return true;
}

export const isCancelling = (scanId: string): boolean =>
  running.get(scanId)?.signal.aborted ?? false;

export { CancelledError, wasCancelled } from './run-context.ts';
