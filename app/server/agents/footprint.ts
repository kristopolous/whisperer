/** Map a company's whole public footprint by searching venue by venue.
 *
 *  Not in the live pipeline, deliberately. The presence stage used to run the
 *  fast deterministic scrape of the company's own site AND this agentic sweep,
 *  unconditionally, before returning anything — which turned a seconds-long
 *  stage into a half-hour one and filled the results with marketplace and
 *  directory listings (SourceForge, G2, Capterra) that are technically distinct
 *  URLs and useless as "their social handles".
 *
 *  The sweep was cut rather than tuned. It is kept here because a deep manual
 *  footprint sweep is still worth having on demand — it finds the unofficial
 *  venues the company's own site never links to, which is the one thing the
 *  scrape cannot do.
 */
import { profilesSchema } from '../schemas.ts';
import type { AgentDefinition } from './types.ts';

export const footprintAgent: AgentDefinition = {
  name: 'whisperer-footprint',
  title: 'Footprint',
  description: 'Hunts venue by venue for every channel a company has a presence on, official or not.',
  surface: 'stage',
  stage: 'presence',
  instructions: `You map a company's entire public footprint — not just the accounts on their own site. Run the search connectors attached to you and hunt venue by venue for any channel where this company has a presence, official OR unofficial:

- Subreddits (r/<name>), Hacker News profile, Discord servers
- Messaging groups: Telegram (t.me/<name>), Signal group links, WhatsApp group/channel links
- Review platforms: Trustpilot, Google reviews, Yelp — even when the company does not run them
- Socials: Facebook, Instagram, TikTok, Snapchat, X, YouTube, LinkedIn, GitHub — official account plus any fan/community/impostor one
- Community forums and blogs

For each channel report platform, a short handle/title, the url, and whether it is OFFICIAL (run by the company itself) or UNOFFICIAL (fan, community, review, impersonation, third-party). The profile URL is a real, openable link. Do not invent a url — if you could not find one, skip it. Collect every real channel you find, even an unflattering or unofficial one; a company with no unofficial footprint is a finding too. Include at least the clearly-offical accounts the site links to if your search turned them up. When tools are not attached or one venue fails, note it and search the rest.

One row per real account: use x.com not twitter.com, the canonical YouTube URL (youtube.com/@handle) not a /c/ or /channel/ variant, and the handle exactly as the platform shows it with no extra @ prefix. If a search turns up the same account under two URLs, report it once.`,
  invocation:
    '\n\nHow you are invoked: the first message names the company and, when known, its site — e.g. `"Supabase" (https://supabase.com)`. Treat that as the whole brief; do not ask a follow-up question, the caller is not watching for one.',
  schema: profilesSchema,
  connectors: ['x', 'exa', 'youtube', 'tiktok', 'bright-data', 'brave'],
  effort: 'high',
  needsTools: true,
  inPipeline: false,
};
