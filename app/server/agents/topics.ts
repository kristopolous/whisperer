/** Fold a run's raw theme vocabulary into a handful of real topics.
 *
 *  Why this exists: the buzz agent names themes per mention, in batches, and
 *  each batch invents its own phrasing. A real run produced 88 distinct labels
 *  across 60 mentions — "pricing opacity", "credit costs", "credits & pricing"
 *  and "unclear billing" all present, all counting one. Mechanical
 *  consolidation catches the spelling variants and nothing else, so the top
 *  eight covered under half the discussion and every month rendered as a
 *  remainder band.
 *
 *  Grouping synonyms is a language judgement, which is what a model is for. It
 *  is also the *right* use of one here: no retrieval, no tools, one cheap call
 *  over a list of words that have already been collected. Deterministic code
 *  gathers the vocabulary, the model groups it, and deterministic code applies
 *  the grouping and does the arithmetic.
 *
 *  Failure is not fatal, and the call is time-boxed. If it fails or runs long
 *  the chart falls back to mechanical consolidation, which is worse but real —
 *  a panel that degrades beats a stage that hangs.
 *
 *  Members come back as index numbers rather than as the theme strings. The
 *  first version asked for the strings copied verbatim, and on a local model
 *  that was both the slowest possible answer — several thousand characters of
 *  exact transcription, which took longer than the endpoint would wait — and
 *  the most fragile, because a theme reworded even slightly matches no mention
 *  and its discussion silently disappears. Indices make the answer a few dozen
 *  integers, and a wrong one is out of range and can be discarded rather than
 *  quietly mis-attributed.
 */

import { topicsSchema } from '../schemas.ts';
import type { AgentDefinition } from './types.ts';

export const TOPICS_INSTRUCTIONS = `You group a list of discussion themes into the small set of subjects they are really about.

You are given every theme that came out of reading public discussion of one product, each with how many times it was used. Different batches of reading invented different words for the same subject; your job is to put those back together.

Rules:
- Group by subject, not by wording. "credit costs", "pricing opacity" and "unclear billing" are one topic — what something costs and how legible that is. "auth" and "authentication" are obviously one. "cold starts" and "slow builds" are NOT one: both are about speed, but a user hits them in completely different places.
- Name each topic in two or three words, in the vocabulary the themes themselves use. Do not invent a corporate category name; "credits & pricing" is right, "monetisation strategy" is not.
- Refer to each theme by the index number it was given. Never repeat the text.
- Put a theme in exactly one topic. If it genuinely belongs to no group with any weight behind it, leave it out entirely rather than forcing it somewhere.
- Return at most 8 topics, most discussed first. Fewer is fine and usually better: this is a chart someone reads at a glance, and two bands that mean nearly the same thing are worse than one honest band.
- Prefer groups that cover a lot of the discussion. A topic used once is not a topic, it is a detail.`;

export const topicsAgent: AgentDefinition = {
  name: 'whisperer-topics',
  title: 'Topics',
  description: "Groups a run's raw theme vocabulary into the few subjects people are actually discussing.",
  surface: 'stage',
  stage: 'buzz',
  instructions: TOPICS_INSTRUCTIONS,
  invocation:
    '\n\nHow you are invoked: the first message names the product, then gives a JSON array of '
    + 'numbered themes, one per line, as `index: theme (count)`. Group them and return the topics, '
    + 'referring to each theme by its index.',
  schema: topicsSchema,
  connectors: [],
  effort: 'low',
  inPipeline: true,
};
