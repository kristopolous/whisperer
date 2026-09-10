/** Ask the model when a deterministic step comes up empty.
 *
 *  The pipeline is deliberately deterministic: parse a URL, read a JSON-LD
 *  block, match a known shape. That is right, because those steps are cheap,
 *  repeatable and testable, and a model asked to do them is slower and
 *  occasionally inventive. But a parser only knows the shapes somebody wrote
 *  down, and the world keeps producing new ones — `microsoft/markitdown` is a
 *  repository to every human who has ever seen GitHub and threw inside
 *  `new URL()`, and the failure surfaced as "cannot work out an issue tracker",
 *  which reads as the tracker being unfindable rather than the string being a
 *  shorthand nobody had handled.
 *
 *  There is a model attached to this thing. When the deterministic path fails,
 *  it should be asked.
 *
 *  Three rules make that safe, and they are the whole design:
 *
 *  1. **Only after failure.** Never in place of the parser. The parser is
 *     faster, free, and cannot invent — this is a fallback, not a strategy.
 *  2. **The answer is verified deterministically.** Whatever comes back goes
 *     through the same validator the caller would have used on real input, and
 *     is discarded if it does not pass. A model that returns a plausible URL
 *     for a tracker that does not exist has produced a wrong answer, which is
 *     worse than the refusal it replaced. `verify` is where the caller can also
 *     check the thing is actually reachable.
 *  3. **It says so.** Every rescue is logged with what failed, what was
 *     suggested and whether it survived verification. A value that silently
 *     came from a model rather than from the data is exactly the kind of thing
 *     that takes a day to find later.
 */

import { rescueAgent } from './agents/rescue.ts';
import { runAgent } from './agents/runtime.ts';
import { why } from './errors.ts';

export interface RescueRequest<T> {
  /** What was being worked out, in the words a person would use — "the issue
   *  tracker for this project", "the published rating on this page". */
  what: string;
  /** The input the deterministic path could not handle. */
  input: string;
  /** Anything else known about the subject that makes the question answerable.
   *  Facts only; this is evidence, not instruction. */
  context?: Record<string, unknown>;
  /** Turns the model's suggestion into the value, or rejects it. Runs the same
   *  checks real input would face. May be async, so a caller can confirm the
   *  answer actually resolves before trusting it. */
  verify: (suggestion: string) => Promise<T | null> | T | null;
  emit: (level: 'info' | 'warn', text: string) => void;
}

/** The model's best answer, verified — or null, and said out loud. */
export async function rescue<T>({ what, input, context, verify, emit }: RescueRequest<T>): Promise<T | null> {
  emit('info', `could not work out ${what} from ${JSON.stringify(input)} — asking the model`);

  let answer: { value?: string; confident?: boolean; why?: string };
  try {
    answer = await runAgent<{ value?: string; confident?: boolean; why?: string }>(rescueAgent, {
      note: what.slice(0, 40),
      prompt: `What is needed: ${what}\n`
        + `What the caller had: ${JSON.stringify(input)}\n`
        + (context ? `What else is known:\n${JSON.stringify(context, null, 1)}\n` : ''),
      timeoutMs: 60_000,
    });
  } catch (error) {
    emit('warn', `the model could not supply ${what} either — ${why(error)}`);
    return null;
  }

  const suggestion = (answer.value ?? '').trim();
  if (!suggestion || answer.confident === false) {
    // A stated inability is a real answer and better than a guess: it stops
    // the caller spending anything else on this.
    emit('warn', `the model would not commit to ${what}${answer.why ? ` — ${answer.why}` : ''}`);
    return null;
  }

  let verified: T | null = null;
  try {
    verified = await verify(suggestion);
  } catch (error) {
    emit('warn', `checking the model's ${what} failed — ${why(error)}`);
    return null;
  }

  if (verified === null || verified === undefined) {
    emit(
      'warn',
      `the model suggested ${JSON.stringify(suggestion)} for ${what}, and it did not check out — `
      + 'ignoring it rather than using a value nothing confirms',
    );
    return null;
  }

  emit('info', `${what}: ${suggestion} (from the model, verified)`);
  return verified;
}
