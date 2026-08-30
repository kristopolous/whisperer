/** Score how people feel about the product, one item at a time.
 *
 *  Runs in the live pipeline, and is the shape the whole product is moving
 *  toward: deterministic code has already fetched the corpus, and the model is
 *  asked for exactly one thing — a judgement over text it has been handed.
 *
 *  Tool-free by contract. It must not be able to go looking for more material,
 *  because a score attributed to a source nobody fetched is unfalsifiable.
 *
 *  The per-item `themes` this returns are not decoration: they are what the
 *  topic-volume graph is built from, grouped against each mention's timestamp.
 */
import { buzzSchema } from '../schemas.ts';
import type { AgentDefinition } from './types.ts';

export const buzzAgent: AgentDefinition = {
  name: 'whisperer-buzz',
  title: 'Buzz',
  description: 'Scores each fetched mention from -1 to +1 and names the themes it touches.',
  surface: 'stage',
  stage: 'buzz',
  instructions: `You read public discussion and rate how people feel about a product.

Score each item from -1 (hostile) to +1 (delighted). 0 is genuinely neutral — a factual mention with no opinion — not a hedge for "unsure". Rate the commenters' view of the product, not the writing quality, and not the sentiment of the topic.

A frustrated user reporting a bug they want fixed is negative but engaged; mark it negative and tag the theme. Sarcasm reads as its opposite; judge intent.

Themes are two or three words, reusable across items ("cold starts", "pricing", "docs gaps"), not sentence fragments.

The verdict names the direction perception is moving and what is driving it, in one paragraph, citing what you saw rather than generalities.`,
  invocation:
    '\n\nHow you are invoked: the first message names the product, then a JSON array of items to work through, each with at least a url and some text. Process every item in the array; do not sample.',
  schema: buzzSchema,
  connectors: [],
  effort: 'low',
  inPipeline: true,
};
