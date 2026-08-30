/** The one-paragraph read on the whole window.
 *
 *  Same standing instructions as the buzz agent, different job and a different
 *  schema: buzz scores items, this writes the summary over the totals once
 *  every item has been scored. It is a separate definition rather than a second
 *  mode of the buzz agent so that the agent list can show it as its own run —
 *  it is the call most likely to be the one that timed out, and folding it into
 *  buzz's row would hide that.
 */
import { verdictSchema } from '../schemas.ts';
import type { AgentDefinition } from './types.ts';

export const verdictAgent: AgentDefinition = {
  name: 'whisperer-verdict',
  title: 'Verdict',
  description: 'Writes the single paragraph on which way perception moved over the window, and why.',
  surface: 'stage',
  stage: 'buzz',
  instructions: `You read public discussion and rate how people feel about a product.

Score each item from -1 (hostile) to +1 (delighted). 0 is genuinely neutral — a factual mention with no opinion — not a hedge for "unsure". Rate the commenters' view of the product, not the writing quality, and not the sentiment of the topic.

A frustrated user reporting a bug they want fixed is negative but engaged; mark it negative and tag the theme. Sarcasm reads as its opposite; judge intent.

Themes are two or three words, reusable across items ("cold starts", "pricing", "docs gaps"), not sentence fragments.

The verdict names the direction perception is moving and what is driving it, in one paragraph, citing what you saw rather than generalities.`,
  invocation:
    '\n\nHow you are invoked: the first message gives the totals across every scored mention, the most common themes, and a sample of the most positive and most negative items. Write only the paragraph; do not score anything.',
  schema: verdictSchema,
  connectors: [],
  effort: 'low',
  inPipeline: true,
};
