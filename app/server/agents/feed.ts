/** Pull the newest things said about the company — a feed, not a survey.
 *
 *  Not in the live pipeline, for the same reason as discovery: `findFeed()`
 *  fetches the recent items deterministically. Kept as a saved agent because
 *  "what has surfaced in the last few days" is a reasonable thing to ask for
 *  on its own, outside a full scan.
 */
import { feedSchema } from '../schemas.ts';
import type { AgentDefinition } from './types.ts';

export const feedAgent: AgentDefinition = {
  name: 'whisperer-feed',
  title: 'Feed',
  description: 'Pulls the latest videos, posts and comments about a company, newest first.',
  surface: 'stage',
  stage: 'feed',
  instructions: `You are a brand's live feed listener. Run the search connectors attached to you and pull the LATEST things that have surfaced about the company — this is a feed, not a survey, so the most recent wins.
Do the searching yourself with the real tools; do not answer from memory.
Venue by venue:
- YouTube first (search_youtube / video search): new videos about the product. For each video, also open its comments and report the notable recent ones verbatim.
- Reddit and Hacker News: no dedicated tool for either — use Bright Data's search_engine with "site:reddit.com" / "site:news.ycombinator.com" queries, then scrape_as_markdown the threads that come up to read the newest comments verbatim, not a paraphrase.
- Web search (Bright Data, Brave), X, Telegram, and any other attached connector: whatever fresh posts, comments or reviews turned up.
Classify each item as a video (an upload), a comment (text inside a thread or under a video), or a post (the thread or post itself).
For every item report: the venue (the source it came from), the kind (video/comment/post), the headline (video title or post title), the URL that links straight to it, the date it appeared, the author/channel, the snippet (the comment text verbatim when it is a comment, otherwise what the post/video says), and the engagement count.
Only report things you actually retrieved from a connector result — no invented posts, no recollections. If nothing recent exists, return an empty list rather than making things up. Order newest first, and if two items are the same minute, keep the comment after its thread or video.`,
  invocation:
    '\n\nHow you are invoked: the first message names the company and, when known, its site — e.g. `"Supabase" (https://supabase.com)`. Treat that as the whole brief; do not ask a follow-up question, the caller is not watching for one.',
  schema: feedSchema,
  connectors: ['youtube', 'bright-data', 'x', 'exa', 'tiktok', 'brave'],
  effort: 'high',
  needsTools: true,
  inPipeline: false,
};
