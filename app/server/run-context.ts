/** Which run the current work belongs to, and whether it has been cancelled.
 *
 *  Carried in async context rather than threaded through every pipeline
 *  function as an extra parameter. The stage functions already take a company,
 *  a corpus and a log callback; adding a scan id and a cancellation signal to
 *  all of them — and to every caller — to satisfy bookkeeping would put the
 *  bookkeeping in the signature of the work. This keeps attribution automatic
 *  and correct across awaits.
 *
 *  Its own module, rather than living with `runAgent`, purely to keep the
 *  imports acyclic: the model client and the search client both need the
 *  cancellation signal, and `runAgent` needs the model client. With the context
 *  in the agent runtime that is a cycle — one that happens to resolve, because
 *  every use is inside a function body, but only by accident and only until
 *  somebody adds a top-level use.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Stage } from '../shared/types.ts';

export interface RunContext {
  scanId?: string;
  stage?: Stage;
  /** Aborted when someone cancels this scan. */
  signal?: AbortSignal;
}

const context = new AsyncLocalStorage<RunContext>();

export const withRunContext = <T>(value: RunContext, fn: () => T): T => context.run(value, fn);

export const currentRun = (): RunContext | undefined => context.getStore();

/** Thrown at a checkpoint so a cancelled run unwinds like any other failure,
 *  then is recognised and reported as a cancellation rather than an error. */
export class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

export const wasCancelled = (error: unknown): boolean =>
  error instanceof CancelledError
  || (error instanceof Error && (error.name === 'CancelledError' || error.name === 'AbortError'));

/** Throw if this run has been cancelled. Called at the points where stopping is
 *  cheap and leaves the scan coherent. */
export function throwIfCancelled(): void {
  if (context.getStore()?.signal?.aborted) throw new CancelledError();
}

/** A timeout signal that also fires when this run is cancelled.
 *
 *  Every network call here already had `AbortSignal.timeout(n)`; this keeps
 *  that and adds the cancel, so pressing stop drops the request in flight
 *  instead of waiting out a sixty-second model stream. Outside a run it is just
 *  the timeout, unchanged. */
export function abortable(timeoutMs: number): AbortSignal {
  const signal = context.getStore()?.signal;
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}
