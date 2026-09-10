/** Stop hammering a host that is plainly down.
 *
 *  Measured on a real run: the inference host started writing its own errors
 *  into the token stream, and the complaint triage stage failed a batch, logged
 *  it, and moved to the next one. Then it did that again. Ten identical lines
 *  in ninety seconds, and with a corpus of 1,590 mentions at six per batch it
 *  had another two hundred and fifty batches to get through — roughly two hours
 *  of a dashboard saying "running", of paid retrieval sitting finished and
 *  unused, and of a progress bar advancing, to produce nothing at all.
 *
 *  Every part of that was working as written. Each batch is wrapped so one bad
 *  response cannot lose the other two hundred, which is right when a failure is
 *  about the batch. It is exactly wrong when the failure is about the host:
 *  then every remaining batch is guaranteed to fail the same way, and the loop
 *  is a slow, expensive way of arriving at the same conclusion the third
 *  failure already justified.
 *
 *  So: a run of consecutive failures that all say the same thing is treated as
 *  a statement about the upstream rather than about the work, and the stage
 *  gives up with a message naming what actually broke. Any success resets it —
 *  a host that answers one batch in three is degraded, not down, and grinding
 *  through that is a reasonable thing to do.
 */

import { describeError, engineFailure } from './errors.ts';

/** Three, and stated out loud in the message rather than applied quietly.
 *
 *  One failure is a bad batch. Two is possibly a bad batch. Three consecutive
 *  failures with the same cause is a property of the host, and waiting for a
 *  fourth costs another thirty seconds to learn nothing. */
const CONSECUTIVE_BEFORE_GIVING_UP = 3;

/** What two failures have to share to count as "the same failure".
 *
 *  Compared on a normalised prefix rather than the whole message, because a
 *  JSON parse error carries the byte offset it gave up at and that offset
 *  differs every time. Two errors that differ only in where the truncation
 *  landed are one error. */
const signature = (error: unknown): string =>
  describeError(error)
    .toLowerCase()
    .replace(/\d+/g, '#')
    .slice(0, 80);

export class UpstreamTrouble {
  private consecutive = 0;
  private last = '';
  private total = 0;

  constructor(
    private readonly label: string,
    private readonly emit: (level: 'info' | 'warn', text: string) => void,
  ) {}

  /** A batch succeeded. Whatever was wrong is not consistently wrong. */
  ok(): void {
    this.consecutive = 0;
  }

  /** A batch failed. Throws when the failures have stopped being about batches.
   *
   *  Throwing from the caller's `catch` is deliberate: it unwinds the stage the
   *  same way any other stage failure does, so it is reported, recorded against
   *  the scan and visible — rather than the stage completing "successfully"
   *  having judged nothing. */
  record(error: unknown): void {
    this.total += 1;
    const current = signature(error);
    this.consecutive = current === this.last ? this.consecutive + 1 : 1;
    this.last = current;

    const upstream = engineFailure(error);
    const detail = describeError(error).slice(0, 160);

    if (this.consecutive < CONSECUTIVE_BEFORE_GIVING_UP) {
      this.emit('warn', `${this.label} batch failed — ${detail}`);
      return;
    }

    // Said once, with the count, instead of once per remaining batch.
    throw new Error(
      `${this.label}: ${this.consecutive} batches in a row failed the same way, so this is the `
      + `service and not the data — giving up rather than sending the rest. `
      + (upstream ?? `The failure was: ${detail}`),
    );
  }

  /** How many batches failed in total, for a stage that survived them. */
  get failures(): number {
    return this.total;
  }
}
