---
name: extract-social-media
description: Given a website URL, find every social and community account that company or project runs — GitHub, LinkedIn, X, Discord, YouTube, Reddit and ~25 more — by rendering the page with a headless browser and classifying the outbound links. Use when asked where a company has a presence, to map a company's channels, or to collect handles before monitoring or outreach.
---

# Extract social media presence

Given a website, return the accounts that site owns. For `https://www.truefoundry.com/`
that is GitHub, LinkedIn, X and Discord; every site differs, so extract whatever is
actually there rather than checking a fixed list.

## Why a headless browser

Social icons almost always live in a footer, and footers are usually built by
JavaScript. `curl` on a modern marketing site returns an empty shell — the links
are not in the HTML it sends. Lightpanda renders the page first, which is what
makes the difference between four results and zero.

## Procedure

1. **Render the page.**

   ```bash
   scripts/scrape.sh https://www.truefoundry.com/ > page.html
   ```

   `scrape.sh` finds Lightpanda on `PATH`, at `$LIGHTPANDA_BIN`, or downloads the
   static nightly binary into a cache dir. It falls back to `curl` and says so on
   stderr; if that happens, say in your answer that JS-rendered links may be missing.

2. **Classify the links.**

   ```bash
   python3 scripts/extract_social.py --base https://www.truefoundry.com/ < page.html
   ```

   Output is JSON: `{"source": ..., "profiles": [{"platform", "handle", "url",
   "confidence", "hits"}]}`. URLs are canonicalized, so `twitter.com/foo` and
   `x.com/foo` collapse to one row, as do `discord.com/invite/X` and `discord.gg/X`.

3. **Widen only if the first pass looks thin.** By default only high-confidence
   profiles are returned — links found in the page chrome (footer, header, nav,
   `rel="me"`, schema.org `sameAs`) or whose handle echoes the domain. A page that
   puts its icons somewhere unusual may come back empty:

   ```bash
   python3 scripts/extract_social.py --base URL --all < page.html
   ```

   `--all` includes every handle the page mentions. On a site with a testimonial
   wall that means dozens of unrelated people, so treat those rows as leads to
   check, not as the company's accounts. Weigh `hits` and `confidence` when
   deciding what to keep.

4. **Try one more page when a footer is thin.** `/about`, `/community`, `/contact`
   and `/docs` often carry links the homepage omits. Merge results by canonical URL.

5. **Report.** A short table — platform, handle, URL — plus a sentence on anything
   notable: a Discord invite implies a live community, a GitHub org invites a repo
   count, no LinkedIn on a B2B site is worth flagging.

## Notes

- Both scripts are standard-library Python 3 and POSIX shell; nothing to install.
- `--all-links` adds a list of off-site hosts that matched no known platform. Use it
  when you suspect a presence on a platform the table does not cover yet; add new
  platforms to `PLATFORMS` in `scripts/extract_social.py`.
- Rendering waits for network idle and takes a few seconds. Pass a longer wait as
  the second argument to `scrape.sh` for a slow site: `scripts/scrape.sh URL 12000`.
- See `references/platforms.md` for what is recognized and how handles are normalized.
