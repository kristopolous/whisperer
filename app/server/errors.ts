/** Say what actually went wrong.
 *
 *  `fetch failed` is Node's entire contribution when a request does not
 *  complete. The reason — connection refused, host not found, TLS rejected,
 *  socket timed out, and which address it was — sits on `error.cause`, one or
 *  two links down a chain nobody was walking. Every report in this app read
 *  `error.message` and stopped, so a dead model host, an unplugged network and
 *  a wrong port all arrived on screen as the same two words.
 *
 *  This walks the chain and puts the operative part back, then adds the one
 *  sentence a person needs to act: `fetch failed` says nothing about what to do,
 *  `ECONNREFUSED 127.0.0.1:11434` says the thing on that port is not running.
 */

interface Causal { message?: string; cause?: unknown; code?: string; errors?: unknown[] }

/** Node's network error codes, in the terms somebody can act on. */
const MEANING: Record<string, string> = {
  ECONNREFUSED: 'nothing is listening there',
  ENOTFOUND: 'that hostname does not resolve',
  ECONNRESET: 'the connection was dropped mid-request',
  EHOSTUNREACH: 'no route to that host',
  ENETUNREACH: 'the network is unreachable',
  ETIMEDOUT: 'it never answered',
  EPIPE: 'the connection closed while writing',
  EAI_AGAIN: 'DNS lookup failed — usually no network',
  CERT_HAS_EXPIRED: 'its TLS certificate has expired',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'it presented a self-signed certificate',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'its TLS certificate could not be verified',
  ABORT_ERR: 'it was cancelled or timed out',
};

/** Everything in the cause chain, outermost first, without repeats. */
function chain(error: unknown, seen = new Set<unknown>()): Causal[] {
  if (!error || typeof error !== 'object' || seen.has(error)) return [];
  seen.add(error);
  const node = error as Causal;
  // `AggregateError` — what a happy-eyeballs connection attempt throws when
  // every address failed. The useful code is on the members, not the wrapper.
  const nested = Array.isArray(node.errors) ? node.errors : [];
  return [node, ...chain(node.cause, seen), ...nested.flatMap((e) => chain(e, seen))];
}

/** A message worth printing.
 *
 *  Keeps the original wording — a failure should be reported in its own words,
 *  not paraphrased into something that no longer matches the logs — and appends
 *  what the chain adds to it. */
export function describeError(error: unknown): string {
  if (!error) return 'unknown error';
  const links = chain(error);
  const head = (error instanceof Error ? error.message : String(error)).trim() || 'unknown error';

  const code = links.map((link) => link.code).find((c): c is string => typeof c === 'string');
  // A deeper message that says more than the outer one. `fetch failed` is the
  // canonical case: its cause carries the address and the syscall.
  const detail = links
    .slice(1)
    .map((link) => (typeof link.message === 'string' ? link.message.trim() : ''))
    .find((message) => message && message !== head);

  const parts = [head];
  if (detail) parts.push(detail);
  if (code && MEANING[code] && !head.includes(code) && !(detail ?? '').includes(MEANING[code])) {
    parts.push(MEANING[code]);
  }

  // De-duplicated, because a chain often repeats itself and "fetch failed —
  // fetch failed" is worse than the original.
  const seen = new Set<string>();
  return parts.filter((part) => part && !seen.has(part) && seen.add(part)).join(' — ');
}
