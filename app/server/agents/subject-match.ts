/** Is this actually about the product we are watching?
 *
 *  Product names collide, and the open web returns the collisions. "Bolt" is a
 *  ride-hailing company, a Helldivers pistol and a fastener; "GIMP" is a search
 *  for motorbikes as often as an image editor; "Replit" is clean but "Lovable"
 *  is an adjective. Left alone these arrive as ordinary mentions, get scored,
 *  get counted in the sentiment, and can be triaged into defects for a product
 *  that has none of those problems.
 *
 *  The exclude-term regex in the pipeline catches the obvious ones for nothing,
 *  and is where the work should be done. This reads what is left over.
 *
 *  Two questions, in this order, and the order carries the whole method:
 *
 *    1. What is this item about? — answered without being told what we want.
 *    2. Is that the same thing as the subject? — compared against the answer.
 *
 *  Asking the second question alone ("is this about Bolt.new?") primes it: the
 *  model has the conclusion in hand and looks for a way to agree. Classifying
 *  first produces a description the comparison has to be made against, so
 *  disagreement has somewhere to come from.
 */

import { subjectMatchSchema } from '../schemas.ts';
import type { AgentDefinition } from './types.ts';

export const SUBJECT_MATCH_INSTRUCTIONS = `You decide whether a post is about the thing we are watching, or about something else that happens to share its name.

Work in this order for every item. The order is not optional, and it is the whole method.

1. TOPIC. Say what the item is about, in a few words, WITHOUT reference to the subject you were given. Name the actual thing being discussed — the product, game, company, tool or object. Write what is in front of you, not what you expect to find. If it is about a piece of software, name that software. If it is about a vehicle, a weapon in a game, a person or a hardware part, say so.
2. THEN compare. Only now look at the subject description. Is the thing you just named the same thing, or a different thing that shares a name?

Answer "same" only when the topic you wrote in step 1 is the subject. Sharing a word is not sharing an identity. A ride-hailing app called Bolt is not a web app builder called Bolt.new. A gun in a video game called the Bolt Pistol is not either of them.

Judge the item, not the search that found it. It arrived here because a search matched some words; that is not evidence.

When the item is genuinely too thin to tell — a bare link, a title with no subject in it — answer "same": the retrieval already had a reason to return it, and discarding readable-but-unclear items loses real complaints. Reserve "different" for items you can positively identify as something else.

Return every index you were given, exactly once.`;

export const subjectMatchAgent: AgentDefinition = {
  name: 'whisperer-subject',
  title: 'Subject disambiguation',
  description:
    'Classifies what each ambiguous post is actually about, then says whether that is the product '
    + 'being watched or something else with the same name.',
  surface: 'stage',
  stage: 'discovery',
  instructions: SUBJECT_MATCH_INSTRUCTIONS,
  invocation:
    '\n\nHow you are invoked: the first message describes the subject, then gives numbered items, '
    + 'one per line. Return a topic and a verdict for every index.',
  schema: subjectMatchSchema,
  connectors: [],
  effort: 'low',
  inPipeline: true,
};
