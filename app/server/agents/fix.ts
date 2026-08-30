/** Write the patch.
 *
 *  The last step of the claim: a public complaint, carried to a diagnosis, and
 *  then to a change that makes the tests pass. Nothing here is applied to
 *  anybody's repository — the runner works in a throwaway copy and reports the
 *  diff. Turning that into a pull request is a separate, deliberate act.
 *
 *  Changes come back as targeted find/replace edits, not whole files and not a
 *  unified diff. All three were tried and the reasons are specific:
 *
 *   - A unified diff fails to apply. Wrong line numbers, wrong context,
 *     whitespace drift — and a patch that will not apply is indistinguishable
 *     from a wrong one until you look.
 *   - A whole file has to survive being a JSON string. Asked to rewrite a
 *     140-line Python file, a model emitted unescaped `"""` docstrings and
 *     turned `\n` into `n`, so the response would not parse and the file would
 *     not have run if it had. It also silently damaged an ASCII-art constant it
 *     had no reason to touch, which the tests could not catch.
 *   - An edit is a few lines of context and a few lines of replacement. Short
 *     strings are far likelier to survive escaping intact, and an edit
 *     physically cannot alter code it does not quote.
 *
 *  The requirement that `find` appears exactly once is what makes it safe: an
 *  edit that matches nothing, or matches twice, is rejected rather than applied
 *  somewhere unintended.
 */

import { fixSchema } from '../schemas.ts';
import type { AgentDefinition } from './types.ts';

export const FIX_INSTRUCTIONS = `You are an engineer fixing a diagnosed defect, and writing the test that proves it is fixed.

You are given the bug report, the diagnosis, and the full current contents of the relevant files. Return the complete new contents of every file you change.

What is required of the change:
- Fix the actual cause named in the diagnosis. Do not paper over the symptom.
- Add a regression test that fails against the current code and passes against yours. If the project has tests, put it with them and match their style, imports and naming exactly — a test that does not run is not a test.
- Change as little as possible. Every line you touch is a line a reviewer has to read and a chance to break something the tests do not cover.
- Keep the existing behaviour that was not complained about. If the code has a feature your fix would remove, preserve it another way and say so.
- Update anything that documents the behaviour you changed — help text, README, prompts, comments. A fix that leaves the documentation describing the old behaviour has not finished.

What is required of the output:
- Return \`edits\`: for each change, the exact existing text to find and what to replace it with.
- \`find\` must be copied character for character from the file you were shown — same indentation, same quotes, same spacing — and must appear EXACTLY ONCE in it. If the line you want to change is not unique, include the lines around it until it is.
- Keep each edit as small as the change requires. An edit cannot damage code it does not quote, which is the point.
- Preserve the file's existing style: indentation, quote style, import order, comment voice. Your change should be indistinguishable from the surrounding code.
- Use \`newFiles\` only for a file that does not exist yet. If there is an existing test file, add your test to it with an edit instead.
- Do not reformat, reorder or "tidy" anything you did not need to touch.
- Do not add dependencies.
- If you cannot fix it from what you were shown, return no edits and say why in \`notes\`. That is a real answer; a plausible guess that fails the tests is not.`;

export const fixAgent: AgentDefinition = {
  name: 'whisperer-fix',
  title: 'Fix',
  description: 'Writes the patch for a diagnosed defect, plus the regression test that proves it.',
  surface: 'loop',
  instructions: FIX_INSTRUCTIONS,
  invocation:
    '\n\nHow you are invoked: the first message gives the product, the issue, the diagnosis, and the '
    + 'full contents of the relevant files. Return whole files. If a previous attempt failed its '
    + 'tests, the failure output is included — read it and fix the cause.',
  schema: fixSchema,
  connectors: [],
  role: 'coding',
  effort: 'high',
  inPipeline: false,
};
