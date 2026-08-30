/** Find a company's accounts by walking its site.
 *
 *  The previous version fetched the homepage once and classified its outbound
 *  links, which assumes every site keeps its accounts in the footer. Plenty do
 *  not: some hide them behind a "Community" page, some only on "Contact", some
 *  in documentation, some on a separate developer subdomain. A one-shot scrape
 *  of the front page finds nothing on those and reports it as "no accounts",
 *  which is a finding rather than a failure to look.
 *
 *  So this one navigates, and that is a deliberate exception to how the rest of
 *  the pipeline works. Everywhere else the URLs are known in advance and a
 *  tool-calling loop would be pure overhead. Here they are not: which page of
 *  an unfamiliar site is worth opening is a judgement about that specific site,
 *  and it can only be made after seeing the last page.
 *
 *  The split still holds. The model decides WHERE to go; deterministic code
 *  does the fetching, holds the budget, and refuses to leave the site. The
 *  model never gets a tool, never sees a network, and cannot walk off the
 *  domain or into an infinite crawl.
 */

import { crawlSchema } from '../schemas.ts';
import type { AgentDefinition } from './types.ts';

export const CRAWL_INSTRUCTIONS = `You are exploring a company's own website to find every account and community it runs.

Each turn you are given a page from the site — its text and its links — and everything found so far. Report what this page shows, and say which pages to open next.

Finding accounts:
- Social and community channels count: X, Reddit, Discord, GitHub, YouTube, LinkedIn, Mastodon, Bluesky, Telegram, Slack, forums, mailing lists.
- Mark \`official\` true only for channels the company runs. A community subreddit or a fan Discord is real and worth recording, but it is not official, and the difference decides who can act on what is said there.
- Ignore share buttons: "post this to X" links at a social network without being an account.
- Ignore directory listings — G2, Capterra, SourceForge, package registries. Those are somebody else's page about the company.

Choosing where to go next:
- Pick pages likely to carry accounts that this page did not: community, about, contact, support, developers, docs, blog, careers.
- Copy URLs exactly from the links you were given. Do not invent, guess or complete a URL.
- Never leave this site. An off-site link is a destination to record, not a page to open.
- Two or three pages a turn, not ten. Each one costs a fetch.
- Set \`done\` true once the obvious places have been looked at, or when the pages you are seeing are product and marketing rather than places people gather. Stopping early is correct; a company with three accounts has three accounts.

If a page is a bot check, a login wall, a parked domain or plainly a different company, return no profiles, set \`done\` true, and say which in \`notes\`.`;

export const crawlAgent: AgentDefinition = {
  name: 'whisperer-crawl',
  title: 'Crawl',
  description: "Walks a company's site — choosing which pages to open — to find the accounts and communities it runs.",
  surface: 'stage',
  stage: 'presence',
  instructions: CRAWL_INSTRUCTIONS,
  invocation:
    '\n\nHow you are invoked: each message gives the company, the page just fetched with its text '
    + 'and links, the pages already seen, and the accounts found so far.',
  schema: crawlSchema,
  connectors: [],
  effort: 'low',
  inPipeline: true,
};
