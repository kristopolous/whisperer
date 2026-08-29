# Query patterns

`{X}` is the product name; run each with the aliases too (repo slug, CLI name, domain).

## Exa — general sweep

| Intent | Query |
|---|---|
| Plain mentions | `{X}` |
| Opinion | `{X} review`, `what do you think of {X}`, `{X} experience` |
| Comparison | `{X} vs`, `alternative to {X}`, `switched from {X}` |
| Complaints | `{X} problems`, `{X} limitations`, `why we left {X}` |
| Adoption | `we use {X}`, `{X} in production`, `migrating to {X}` |

## Exa — site-scoped

Scope to where a niche argues. Pick by domain, not habit:

- Infra / devtools: `news.ycombinator.com`, `lobste.rs`, `dev.to`, `reddit.com`
- Data / ML: `huggingface.co`, `kaggle.com`, `medium.com`, `arxiv.org`
- SaaS / business: `g2.com`, `capterra.com`, `trustradius.com`, `producthunt.com`
- Anything with an OSS repo: `github.com/*/issues`, `discourse` and `zulipchat` instances
- Video and long-form: `youtube.com`, `substack.com`

## Reddit

- `search_reddit` with each alias, then with `{X} review` and `{X} vs`.
- Subreddits worth browsing by category: r/devops, r/selfhosted, r/programming,
  r/ExperiencedDevs, r/LocalLLaMA, r/MachineLearning, r/SaaS, r/webdev, plus any
  product- or vendor-specific subreddit that surfaced in the sweep.
- Sort by top within the last year for signal; by new to see whether the conversation
  is still alive.

## Hacker News

- `search_stories` for the name, the domain, and `org/repo`.
- `get_stories` on `top` when you need to know whether something is being discussed
  *right now*.
- A submission with 3 points and no comments is not a discussion — do not cite it as one.

## Dead ends worth skipping

- Press-release aggregators and "top 10 tools" listicles: SEO filler, no opinion in them.
- Job postings that name the tool: evidence of adoption, not of discussion.
- The vendor's own docs, changelog and status page.
