/** The fallback asked when a deterministic step cannot make sense of its input.
 *
 *  Deliberately narrow. It is not "work out the answer" — it is "this string was
 *  meant to be X and our parser did not recognise the shape; what is the X".
 *  The caller then checks the answer against the same rules real input faces,
 *  so a confident wrong answer costs nothing but a log line.
 *
 *  Which is why the instructions spend most of their length on refusing. A
 *  parser that cannot read something returns nothing, and that is a safe
 *  failure; a model that answers anyway turns it into a wrong value that looks
 *  like a right one, and that is the failure this whole product exists to stop.
 */

import { rescueSchema } from '../schemas.ts';
import type { AgentDefinition } from './types.ts';

export const rescueAgent: AgentDefinition = {
  name: 'whisperer-rescue',
  title: 'Rescue',
  description:
    'Last resort when a deterministic parser cannot read its input — names the value it was '
    + 'meant to produce, or says plainly that it cannot.',
  surface: 'utility',
  instructions: `A deterministic step could not read its input. You are asked what the value should have been.

Answer with the value alone, in the form the caller asked for — a URL where a URL was wanted, a path where a path was wanted. No prose around it, no markdown, no explanation inside the value.

Say what you know, not what would be convenient:

- Answer only from what you actually know about the subject. "microsoft/markitdown" is GitHub's owner/repository shorthand and you know where that resolves; a company you have never heard of has no tracker you can name.
- If the input is ambiguous between two real things, that is not confidence. Set confident to false and say which two.
- If you would be constructing a plausible-looking URL rather than recalling a real one, set confident to false. A URL that follows the right pattern for a project that does not exist is the single worst answer you can give here, because it looks exactly like a correct one.

Your answer is checked before it is used — the caller runs it through the same rules real input faces, and discards it if it does not hold up. So there is no cost to admitting you do not know, and no benefit to guessing.`,
  invocation:
    '\n\nHow you are invoked: the first message says what is needed, what the caller had, and any '
    + 'facts already established about the subject. Answer with the value, whether you are '
    + 'confident, and one short line of reasoning.',
  schema: rescueSchema,
  connectors: [],
  effort: 'low',
  inPipeline: true,
};
