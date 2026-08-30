/** Read switching claims out of discussion that has already been collected.
 *
 *  "Who is arriving, who is leaving, and what did they say the reason was" is
 *  the one panel here that a founder reads before the sentiment average, and
 *  until now it was the only panel with no producer at all — it was filled from
 *  a fixture. A chart of invented churn is worse than an empty one, because it
 *  is the kind of number people repeat.
 *
 *  The retrieval is already done: these are mentions the discovery stage
 *  fetched. Deterministic code finds the candidates — a switching claim has a
 *  small, recognisable vocabulary ("switched from", "moved to", "ditched",
 *  "went back to") — and the model does only the part that is genuinely a
 *  language judgement, over text already in hand.
 *
 *  That split matters here more than elsewhere, because the prefilter is
 *  deliberately loose and therefore wrong a lot. "I moved to a different tab",
 *  "we switched from staging to production", a roundup titled "10 tools people
 *  are switching to" — all match, none is a migration. The model's first job is
 *  to throw those away, and the instructions push hard on that: the direction
 *  of a move is easy to invert, and an inverted one turns an arrival into a
 *  departure, which is the most damaging way this panel could be wrong.
 *
 *  Every claim carries the quote it came from. A migration is a strong thing to
 *  assert about a stranger, and the only defensible version of it is the
 *  sentence they actually wrote.
 */

import { migrationsSchema } from '../schemas.ts';
import type { AgentDefinition } from './types.ts';

export const MIGRATIONS_INSTRUCTIONS = `You read public posts and pick out the ones where somebody says they moved between products.

You are given a product name and a numbered list of posts that mention it. Each post matched a loose text filter for switching language, so most of them are not about switching at all. Discarding those is the main part of the job.

What counts as a migration:
- The author says they, or their team, started using one product instead of another. "We moved off X to Y", "switched to Y last month", "ditched X for Y", "went back to X".
- It must be a product-to-product move that has happened or is happening. Not a plan, not a question, not a recommendation to someone else, not a comparison.

What does not count, however strongly it is worded:
- Moving between versions, plans, tiers, branches, environments or files. "Switched from the free plan", "moved to v3", "migrated the database" are not migrations between products.
- Someone reporting what other people are doing, or a headline about a trend. It has to be their own move.
- "Thinking about switching", "should I switch", "considering moving". An intention is not a migration.
- An article, listicle or comparison page that merely uses the vocabulary.

Direction is from the point of view of the named product, and getting it backwards is the worst mistake available here:
- inbound — they moved TO the named product, from something else.
- outbound — they moved AWAY from the named product, to something else.
If the post does not make the direction unambiguous, do not include it.

For each real migration:
- competitor — the OTHER product, named the way the author names it. Never the named product itself. One product, not a list: if they name several, give the one they landed on, and if that is not clear give the first they name.
- quote — the author's own words, copied exactly from the post, the sentence that establishes the move. Do not paraphrase, do not tidy the grammar. If you cannot copy a sentence that says it, this is not a migration you can support.
- reason — why they moved, in a few words, only if they said. Empty string if they did not; do not infer a reason from tone.
- confidence — "high" when the post plainly states their own completed move and the other product; "low" when you are reading between the lines at all.

Refer to each post by the index number it was given. Return an empty list if none of them qualify — that is a normal and common answer, and far better than stretching to fill the chart.`;

export const migrationsAgent: AgentDefinition = {
  name: 'whisperer-migrations',
  title: 'Migrations',
  description: 'Picks out the posts where somebody says they switched to or away from the product, and which way.',
  surface: 'stage',
  stage: 'buzz',
  instructions: MIGRATIONS_INSTRUCTIONS,
  invocation:
    '\n\nHow you are invoked: the first message names the product, then gives numbered posts, one '
    + 'per block, as `index: title — excerpt`. Return only the ones that are real switching claims, '
    + 'referring to each by its index.',
  schema: migrationsSchema,
  connectors: [],
  effort: 'low',
  inPipeline: true,
};
