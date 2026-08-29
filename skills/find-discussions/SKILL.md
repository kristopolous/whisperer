---
name: find-discussions
description: Find where people are talking about a piece of software, a company or a product — Reddit threads, Hacker News posts, forums, blogs, YouTube, Discord and issue trackers — using Exa web search plus the Reddit and Hacker News tools, then summarize the sentiment and the recurring complaints. Use for community listening, competitor research, launch monitoring, or "what are people saying about X".
---

# Find where people discuss a project

Given a product, company or repo, locate the conversations about it and report what
they say. The goal is coverage of *venues* first, then a read on what is actually
being argued.

## Tools this expects

- **Exa** (`exa` MCP) — the general web sweep. Use it for anything not on Reddit or HN.
- **Reddit** (`reddit` MCP) — `search_reddit`, `browse_subreddit`, `get_post_comments`.
- **Hacker News** (`hn` MCP) — `search_stories`, `get_story_info`, `get_stories`.

Check what is attached before planning; work with whichever subset is present and say
in your answer which venues you could not cover.

## Procedure

1. **Fix the search terms.** Collect the aliases people actually type: product name,
   company name, GitHub `org/repo`, the CLI or package name, and the bare domain.
   A name that is also an English word ("Forge", "Comet") needs a qualifier in every
   query — pair it with a category word like `deploy`, `LLM`, `database`.

2. **Sweep the web with Exa.** Run several narrow searches rather than one broad one;
   see `references/query-patterns.md`. At minimum: a general mention search, a
   comparison search (`X vs`), a complaint search (`X problems`), and a site-scoped
   search for the forums that matter in that niche.

3. **Reddit.** `search_reddit` for each alias, then `browse_subreddit` on the two or
   three subreddits that keep coming up — that is where an ongoing conversation lives,
   as opposed to a single post. Pull `get_post_comments` on threads with real
   discussion; the comments carry the opinion, the post title rarely does.

4. **Hacker News.** `search_stories` for each alias. Launch threads (Show HN, Ask HN)
   and any post with a high comment count are worth `get_story_info` — HN comments are
   usually the sharpest technical criticism you will find.

5. **Follow the tail.** Mentions cluster: a Reddit thread links a blog post, the blog
   post's comments name a Discord. Chase one hop, not more.

6. **Report.** Group by venue. For each: the link, the date, roughly how much
   engagement, and one line on what was actually said. Then a short synthesis —
   the recurring praise, the recurring complaints, and which venue is the live one
   worth watching. Quote sparingly and attribute; do not launder one commenter's
   opinion into "users say".

## Judgment

- **Recency matters more than volume.** A 2021 HN thread describes software that no
  longer exists. Say how old a discussion is whenever you cite it.
- **Separate the company's own posts from third-party discussion.** A vendor's blog
  post syndicated to five sites is one voice, not five.
- **Note the absence.** "No Reddit presence and two HN mentions in two years" is a real
  finding, not a failed search — report it plainly instead of padding with weak hits.
- **Do not fabricate engagement numbers.** If a tool did not return a score or comment
  count, leave it out.

## Pairs well with

`extract-social-media` first: the Discord invite, subreddit or GitHub org it finds on
the company's own site tells you which venues to search here.
