/** Decide whether a post reports something wrong, when the vocabulary cannot.
 *
 *  A second pass, and deliberately a grudging one. The regex in search.ts
 *  classifies 159 items instantly and for nothing; this reads what it could not
 *  place, at roughly a minute per ninety items. Measured on r/GIMP the split was
 *  49 found by pattern and 9 more by model — so the model is worth having and is
 *  emphatically not worth running first.
 *
 *  It exists because the two registers of complaint are genuinely different
 *  shapes. "gimp sucks" is a vocabulary problem and a pattern solves it. "I need
 *  more advanced color curves, I came from Paint.NET and used pyrochild's
 *  Curves+" is a feature gap stated as a reminiscence, and no list of words gets
 *  there. That is a judgement, which is what a model is for.
 *
 *  Run only when the cheap pass came up short — see needsModelPass. A corpus
 *  with plenty of flagged complaints has nothing to gain: the flag decides which
 *  items get a share of the model's reading budget, and once that share is full,
 *  finding more candidates changes nothing and costs minutes.
 */

import { complaintsSchema } from '../schemas.ts';
import type { AgentDefinition } from './types.ts';

export const COMPLAINTS_INSTRUCTIONS = `You decide whether a post or comment reports something WRONG with a piece of software.

Work in this order for every item. The order is not optional.

1. QUOTE the words from the item that show the software misbehaving, failing, losing somebody's work, or missing something they needed. Copy them exactly as written — they must appear in the item verbatim.
2. THEN say whether it is a problem report.

An empty quote means false. Always. If you cannot point at the words, you have not found a problem — you have decided there is one and gone looking for support afterwards.

What the quote has to show: the software doing something the writer did not want, or failing to do something they needed. Anger is not evidence on its own. "this is frustrating" is a mood; "the layers got merged when I saved" is a fault.

Not problem reports, however they are worded:
- Showing off work made with the software.
- Asking how to do something that works as designed.
- Tutorials, and requests for tutorials.
- Release announcements, including the part listing what they fixed. A note that a bug WAS fixed is not a report that it is broken.
- Praise, general chat, and anything not about this software at all.

Some items are marked [own community]. Those come from the product's own forum, so they are about this product whether or not they name it — "it crashes when I export" is a report about this software, not an ambiguous sentence. Do not mark one false for failing to name the product. Everything else still applies: no quote, no problem.

Return every index you were given, exactly once.`;

export const complaintsAgent: AgentDefinition = {
  name: 'whisperer-complaints',
  title: 'Complaint triage',
  description: 'Reads the posts the complaint vocabulary could not place, and says which report a real fault.',
  surface: 'stage',
  stage: 'discovery',
  instructions: COMPLAINTS_INSTRUCTIONS,
  invocation:
    '\n\nHow you are invoked: the first message names the product, then gives numbered posts, one '
    + 'per line. Return a verdict for every index.',
  schema: complaintsSchema,
  connectors: [],
  effort: 'low',
  inPipeline: true,
};
