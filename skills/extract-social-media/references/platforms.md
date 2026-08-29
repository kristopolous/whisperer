# Recognized platforms

Defined by the `PLATFORMS` table in `scripts/extract_social.py`. Each entry is a set
of hosts, a path pattern whose first group is the handle, and optional canonical
rewriting.

| Platform | Hosts | Profile shape |
|---|---|---|
| github, gitlab | github.com, gitlab.com | `/{owner}` (repos collapse to their owner) |
| linkedin | linkedin.com | `/company/{x}`, `/in/{x}`, `/school/{x}`, `/showcase/{x}` |
| x | x.com, twitter.com | `/{handle}` — twitter.com rewritten to x.com |
| discord | discord.gg, discord.com | invite code — `discord.com/invite/X` rewritten to `discord.gg/X` |
| slack | *.slack.com | workspace subdomain |
| youtube | youtube.com | `/@x`, `/c/x`, `/channel/x`, `/user/x` |
| facebook, instagram, tiktok, threads, pinterest | — | `/{handle}` |
| reddit | reddit.com | `/r/{sub}`, `/u/{user}` |
| bluesky, mastodon | bsky.app, mastodon.social, fosstodon.org, hachyderm.io | `/profile/{did}`, `/@{user}` |
| telegram, whatsapp | t.me, wa.me, chat.whatsapp.com | invite or handle |
| medium, substack, devto | medium.com, *.substack.com, dev.to | publication or author |
| stackoverflow, npm, pypi, dockerhub | — | package or user namespace |
| twitch, vimeo, soundcloud, spotify | — | channel or artist |
| crunchbase, producthunt | — | organization or product |

## Normalization rules

- **Aliases collapse.** Host rewrites (twitter→x, discord.com/invite→discord.gg) run
  before dedup, so one account yields one row however it was linked.
- **Path kind survives.** `linkedin.com/company/foo` stays `/company/foo`; only
  Discord rebuilds its path from the handle alone.
- **Vanity subdomains** count as the handle for Slack, Substack and Medium
  (`blog.substack.com` → handle `blog`), and are ignored elsewhere so
  `in.linkedin.com/company/foo` still reads as `foo`.
- **Reserved paths are dropped** per platform: `github.com/features`,
  `x.com/intent/tweet`, `facebook.com/sharer`, `linkedin.com/shareArticle` and
  similar plumbing. Share widgets are also rejected by their query string
  (`?url=`, `?text=`, `?via=`).
- **Embed and tracker hosts are dropped** by subdomain: `platform.`, `widgets.`,
  `connect.`, `cdn.`, `static.`, `pixel.`, `analytics.` and friends.

## Adding a platform

Append a `dict(...)` to `PLATFORMS`. Keys: `name`, `hosts`, `path` (group 1 = handle),
optional `host` (canonical host), `vanity` (subdomain is the account), and `canon`
(`"handle"` to rebuild the path from the handle). Add junk path prefixes to `RESERVED`
under the same name.
