/** Write the test that fails.
 *
 *  The rung the ladder could not reach on its own. `reproduced` means a test
 *  that fails against the unpatched code, and until now the only thing that
 *  produced one was the fix run — so a defect could be read, understood and
 *  written up, and still sit at "no test yet that fails against the current
 *  code" unless somebody asked for a patch. Filing is gated on reproduction, so
 *  that gap held up the one step that turns a rumour into a bug report.
 *
 *  It is a separate agent from the fix rather than a mode of it, because the two
 *  jobs want opposite things. A fix is judged by the suite going green and is
 *  allowed to touch the source; a reproduction is judged by the suite going RED
 *  for the reported reason and must not touch the source at all. Asking one
 *  agent for both in one call is how you get a test written to match the patch
 *  that was written beside it — the failure mode `provesTheBug` exists to catch,
 *  and the reason a test the pipeline produced is worth less than one it
 *  produced first.
 *
 *  Writing the test first also makes the fix cheaper and more honest: the patch
 *  then has an acceptance criterion it did not author, and "fixed" means that
 *  criterion changed colour.
 *
 *  Output is whole files, never edits. A reproduction that can only add a new
 *  test file cannot damage an existing one, and cannot quietly weaken a test
 *  that already passes in order to make its own point.
 */

import { reproduceSchema } from '../schemas.ts';
import type { AgentDefinition } from './types.ts';

export const REPRODUCE_INSTRUCTIONS = `You are an engineer writing the test that demonstrates a reported defect. You are NOT fixing it.

You are given the bug report as the public wrote it, a diagnosis against the project's own source, the current contents of the files the diagnosis pointed at, and an existing test file from the project.

The test you write must FAIL against the code you were shown, for the reason in the report. That is the entire job. A test that passes has demonstrated nothing, and a test that fails for any other reason is worse than nothing because it will be read as proof.

What is required of the test:
- Assert the reported behaviour, not the code's current behaviour. Write the assertion that SHOULD hold and let it fail.
- Fail for the reported reason. It must be an assertion about behaviour that fails — not an import error, not a missing fixture, not a syntax error, not a test that never gets collected. Use only what the project already depends on, and only APIs you can see in the files you were given.
- Be deterministic. It will be run on machines faster and slower than yours and on a loaded CI runner. If the defect is about resource use or scaling, assert the thing that grows — a count, a size, a ratio between two input sizes — rather than a wall-clock number, and leave generous headroom so the assertion is about the shape of the curve and not about the speed of the machine. If you also assert a timing, it must be a ratio with a loose threshold, and it must not be the only assertion.
- Be self-contained and fast. Build the input in the test. Do not download anything, do not reach the network, and do not need a file that is not in the repository.
- Match the project's own tests exactly: the same imports, the same naming convention, the same style, the same directory. A test that does not get collected is not a test.
- Say what it is for. A docstring naming the reported defect, and a failure message that tells whoever sees it in red what was expected and what happened. Someone reading the failure a year from now should not need the ticket.

What is required of the output:
- \`files\`: NEW test files only, in full. One is usually right.
- Never return a change to the code under test. Not a fix, not a workaround, not a tweak to make your test pass. The whole value of this step is that the test was written before, and independently of, any patch.
- Never modify or delete an existing test.
- \`expectedFailure\`: the assertion you expect to fail and roughly what the output will say. This is checked against what actually happens, so state it plainly.
- If what you were shown does not let you demonstrate the defect, return no files and say what you would need in \`notes\`. That is a real and often correct answer. A test that cannot fail for the right reason is not worth having.`;

export const reproduceAgent: AgentDefinition = {
  name: 'whisperer-reproduce',
  title: 'Reproduce',
  description: 'Writes a test that fails against the current code, so a reported defect becomes a demonstrated one.',
  surface: 'loop',
  instructions: REPRODUCE_INSTRUCTIONS,
  invocation:
    '\n\nHow you are invoked: the first message gives the product, the issue as it was reported, the '
    + 'diagnosis, the current contents of the files it pointed at, and one of the project’s '
    + 'existing test files for style. Return new test files only. If a previous attempt did not fail '
    + 'for the reported reason, its output is included — read it and fix the cause.',
  schema: reproduceSchema,
  connectors: [],
  role: 'coding',
  effort: 'high',
  inPipeline: false,
};
