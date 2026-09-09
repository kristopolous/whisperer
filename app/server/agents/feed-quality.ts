/** Is this a datapoint, or is it furniture?
 *
 *  The feed was the one stage with no judgement in it at all: deterministic
 *  search, a relevance filter on the URL, and straight onto the screen. What
 *  that produces, measured on a real Replit feed, is a page of chrome —
 *
 *    "Happening now Join today. Sign up with Google… Terms of Service |
 *     Privacy Policy | Cookie Policy | Accessibility | Ads info"
 *
 *    "Welcome to r/replit! … Noticed today the subreddit is on the Community
 *     Hub, so here's a little welcome message!"   (five times over)
 *
 *  — a login wall, a subreddit's boilerplate greeting, and a navigation dump,
 *  all of which pass every test a URL can answer. They are recent, they name
 *  the company, they are not homepages. Only reading them settles it.
 *
 *  So this is the model's job and the reason it is worth the call. The question
 *  is deliberately narrow: not "is this interesting" — taste is not something to
 *  delegate — but "did a person say something specific about this product". A
 *  login prompt did not. An announcement did. A complaint did.
 *
 *  Evidence before verdict, as everywhere else here: the quote is generated
 *  first and the verdict has to rest on it, and the caller checks the quote
 *  actually occurs in the text before believing either.
 */

import { feedQualitySchema } from '../schemas.ts';
import type { AgentDefinition } from './types.ts';

export const FEED_QUALITY_INSTRUCTIONS = `You decide whether a feed item is a real datapoint about a product, or page furniture that happens to mention it.

Work in this order for every item. The order is not optional.

1. QUOTE the words that say something specific about the product — what it did, what changed, what somebody experienced, what was announced. Copy them exactly as they appear in the item.
2. THEN say whether it is a datapoint.

An empty quote means false. Always. If you cannot point at a sentence that says something, there is nothing there.

What IS a datapoint:
- Somebody describing using the product: what worked, what broke, what it cost them.
- An announcement, release, price change, outage or incident.
- An opinion with a reason attached — "it is expensive because a simple app ran to $50".
- A comparison against something else, where a reason is given.

What is NOT, however recent and however often the product is named:
- Sign-in walls, cookie notices, consent pages: "Join today", "Sign up with Google", "See what's happening".
- Navigation, footers and link lists: "Terms of Service | Privacy Policy | Cookie Policy | Careers | Brand Resources".
- A forum or subreddit's standing welcome message. "Welcome to r/x! Noticed today the subreddit is on the Community Hub" is the sidebar, not a post, and it will appear on every thread there.
- A page that is only a title and a name, with no statement in it.
- A bare list of unrelated headlines scraped from a sidebar — several different topics separated by ellipses, none of them developed.
- An opinion with no reason: "it's great", "worst thing ever", on its own.

Judge the text you are given, not the URL it came from. A real post on a page that also carries a cookie banner is a datapoint; a cookie banner on a page with a real title is not.

Return every index you were given, exactly once.`;

export const feedQualityAgent: AgentDefinition = {
  name: 'whisperer-feed-quality',
  title: 'Feed triage',
  description:
    'Reads each feed item and says whether somebody actually said something about the product, or '
    + 'whether it is a login wall, a sidebar or a navigation dump that happens to name it.',
  surface: 'stage',
  stage: 'feed',
  instructions: FEED_QUALITY_INSTRUCTIONS,
  invocation:
    '\n\nHow you are invoked: the first message names the product, then gives numbered items, one '
    + 'per line. Return a quote and a verdict for every index.',
  schema: feedQualitySchema,
  connectors: [],
  effort: 'low',
  inPipeline: true,
};
