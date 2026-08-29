#!/usr/bin/env python3
"""Pull social-media presence out of a page's HTML.

Reads HTML on stdin, writes JSON on stdout:

    {"source": "...", "profiles": [{"platform": "github", "handle": "truefoundry",
                                    "url": "https://github.com/truefoundry"}, ...],
     "unclassified": ["https://..."]}

Only the standard library is used, so it runs in a bare sandbox.
"""
import argparse
import html
import json
import re
import sys
from urllib.parse import urljoin, urlparse, urlunparse

# One entry per platform:
#   hosts   - domains that belong to it
#   path    - regex over the URL path; group 1 is the handle. This is also what
#             rejects non-profile URLs on the same host, together with RESERVED.
#   vanity  - True when a subdomain is itself the account (foo.slack.com)
#   host    - canonical host to rewrite to, when the platform has aliases
#   canon   - "match" (default) keeps the matched path, so /company/foo survives;
#             "handle" rebuilds it from the handle alone, dropping /invite/
PLATFORMS = [
    dict(name="github",     hosts=("github.com",),                path=r"^/([A-Za-z0-9][\w.-]*)"),
    dict(name="gitlab",     hosts=("gitlab.com",),                path=r"^/([A-Za-z0-9][\w.-]*)"),
    dict(name="linkedin",   hosts=("linkedin.com",),              path=r"^/(?:company|in|school|showcase)/([\w%.-]+)",
         host="www.linkedin.com"),
    dict(name="x",          hosts=("twitter.com", "x.com"),       path=r"^/(\w{1,15})", host="x.com"),
    dict(name="discord",    hosts=("discord.gg", "discord.com"),  path=r"^/(?:invite/)?([\w-]+)", host="discord.gg",
         canon="handle"),
    dict(name="slack",      hosts=("slack.com",),                 path=r"^/(?:t/)?([\w-]+)", vanity=True),
    dict(name="youtube",    hosts=("youtube.com", "youtu.be"),    path=r"^/(@[\w.-]+|(?:c|channel|user)/[\w.-]+)",
         host="www.youtube.com"),
    dict(name="facebook",   hosts=("facebook.com", "fb.com"),     path=r"^/([\w.-]+)", host="www.facebook.com"),
    dict(name="instagram",  hosts=("instagram.com",),             path=r"^/([\w.-]+)", host="www.instagram.com"),
    dict(name="tiktok",     hosts=("tiktok.com",),                path=r"^/(@[\w.-]+)", host="www.tiktok.com"),
    dict(name="reddit",     hosts=("reddit.com",),                path=r"^/(r/[\w-]+|u(?:ser)?/[\w-]+)",
         host="www.reddit.com"),
    dict(name="bluesky",    hosts=("bsky.app",),                  path=r"^/profile/([\w.:-]+)"),
    dict(name="threads",    hosts=("threads.net", "threads.com"), path=r"^/(@[\w.-]+)", host="www.threads.com"),
    dict(name="mastodon",   hosts=("mastodon.social", "fosstodon.org", "hachyderm.io"), path=r"^/(@[\w.-]+)"),
    dict(name="telegram",   hosts=("t.me", "telegram.me"),        path=r"^/([\w+-]+)", host="t.me"),
    dict(name="whatsapp",   hosts=("wa.me", "chat.whatsapp.com"), path=r"^/([\w+-]+)"),
    dict(name="twitch",     hosts=("twitch.tv",),                 path=r"^/([\w-]+)", host="www.twitch.tv"),
    dict(name="medium",     hosts=("medium.com",),                path=r"^/(@?[\w.-]+)", vanity=True),
    dict(name="substack",   hosts=("substack.com",),              path=r"^/(\w[\w.-]*)?", vanity=True),
    dict(name="devto",      hosts=("dev.to",),                    path=r"^/([\w-]+)"),
    dict(name="stackoverflow", hosts=("stackoverflow.com",),      path=r"^/(?:users|c)/([\w/-]+)"),
    dict(name="producthunt", hosts=("producthunt.com",),          path=r"^/(?:products|posts)/([\w-]+)"),
    dict(name="crunchbase", hosts=("crunchbase.com",),            path=r"^/organization/([\w-]+)"),
    dict(name="npm",        hosts=("npmjs.com",),                 path=r"^/(?:package|org|~)/([\w@/.-]+)"),
    dict(name="pypi",       hosts=("pypi.org",),                  path=r"^/(?:project|user)/([\w.-]+)"),
    dict(name="dockerhub",  hosts=("hub.docker.com",),            path=r"^/(?:u|r)/([\w/.-]+)"),
    dict(name="pinterest",  hosts=("pinterest.com",),             path=r"^/([\w-]+)"),
    dict(name="vimeo",      hosts=("vimeo.com",),                 path=r"^/([\w-]+)"),
    dict(name="soundcloud", hosts=("soundcloud.com",),            path=r"^/([\w-]+)"),
    dict(name="spotify",    hosts=("open.spotify.com",),          path=r"^/(?:show|artist|user)/([\w-]+)"),
]

# Path prefixes that are the platform's own plumbing rather than someone's profile.
RESERVED = {
    "github": {"features", "pricing", "about", "login", "join", "topics", "explore",
               "marketplace", "sponsors", "collections", "apps", "orgs", "settings", "search"},
    "gitlab": {"explore", "users", "help", "pricing"},
    "x": {"intent", "share", "home", "login", "i", "search", "hashtag", "compose", "settings",
          "privacy", "tos", "widgets"},
    "facebook": {"sharer", "share", "dialog", "plugins", "tr", "login", "help", "policy",
                 "policies", "privacy"},
    "linkedin": {"shareArticle", "sharing", "cws", "uas", "legal"},
    "youtube": {"watch", "embed", "results", "playlist", "shorts"},
    "instagram": {"p", "reel", "explore", "accounts", "stories"},
    "reddit": {"submit", "login"},
    "medium": {"m", "tag", "search", "plans"},
    "telegram": {"share", "iv"},
    "pinterest": {"pin", "pin-builder"},
}

# Hosts that only ever appear as embeds, trackers or SDKs — never a presence.
NOISE_HOSTS = re.compile(
    r"(^|\.)(platform|syndication|widgets|cdn|static|connect|analytics|ads|pixel|badge|api|assets)\."
)

# Query strings for "share this page" widgets, which name a platform without
# the site actually being on it.
SHARE_HINTS = re.compile(r"[?&](url|text|u|mini|title|via|source)=", re.I)

ATTR_RE = re.compile(
    r"""(?:href|content|data-href|data-url|data-link)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))""",
    re.I,
)
BARE_URL_RE = re.compile(r"""https?://[^\s"'<>()\\]+""", re.I)

# Regions where a site links to its *own* accounts. Links in the body of a page
# are usually someone else's — a testimonial wall is full of customer handles.
CHROME_RE = re.compile(
    r"<(footer|header|nav|aside)\b.*?</\1\s*>|<[^>]+\b(?:class|id)\s*=\s*[\"'][^\"']*"
    r"(?:footer|social-link|social-icon|socials|follow-us)[^\"']*[\"'][^>]*>.{0,1200}",
    re.I | re.S,
)
REL_ME_RE = re.compile(r"<a\b[^>]*\brel\s*=\s*[\"'][^\"']*\bme\b[^\"']*[\"'][^>]*>", re.I)
SAMEAS_RE = re.compile(r'"sameAs"\s*:\s*(\[[^\]]*\]|"[^"]*")', re.I)


def candidate_urls(markup: str, base: str):
    """Yield (url, strong) pairs.

    `strong` marks a link the site plausibly owns: it sat in the page chrome, in
    a rel="me" anchor, or in schema.org sameAs. Body links stay weak.
    """
    unescaped = markup.replace("\\/", "/")
    strong_blobs = [m.group(0) for m in CHROME_RE.finditer(markup)]
    strong_blobs += [m.group(0) for m in REL_ME_RE.finditer(markup)]
    strong_blobs += [m.group(1) for m in SAMEAS_RE.finditer(unescaped)]
    strong_text = "\n".join(strong_blobs)

    def urls_in(text: str):
        found = []
        for match in ATTR_RE.finditer(text):
            found.append(next(g for g in match.groups() if g is not None))
        found.extend(BARE_URL_RE.findall(text.replace("\\/", "/")))
        out = []
        for raw in found:
            raw = html.unescape(raw.strip())
            if not raw or raw.startswith(("javascript:", "data:", "#", "mailto:", "tel:")):
                continue
            out.append(urljoin(base, raw))
        return out

    strong_urls = set(urls_in(strong_text))
    for url in urls_in(markup):
        yield url, url in strong_urls


def classify(url: str):
    """-> (platform, handle, canonical_url) or None when it isn't a profile."""
    parsed = urlparse(url)
    host = parsed.netloc.lower().split(":")[0]
    if NOISE_HOSTS.search(host):
        return None
    bare = host.removeprefix("www.")

    for spec in PLATFORMS:
        if not any(bare == h or bare.endswith("." + h) for h in spec["hosts"]):
            continue

        # A vanity subdomain (myco.slack.com, blog.substack.com) is the account
        # itself; only some platforms work that way.
        if spec.get("vanity"):
            for h in spec["hosts"]:
                if bare.endswith("." + h):
                    sub = bare[: -len(h) - 1]
                    if sub and sub != "www":
                        return spec["name"], sub, f"https://{bare}/"

        path = parsed.path.rstrip("/") or "/"
        match = re.match(spec["path"], path)
        if not match or not match.group(1):
            continue
        handle = match.group(1)

        if handle.split("/")[0].lstrip("@") in RESERVED.get(spec["name"], set()):
            return None
        if SHARE_HINTS.search(parsed.query or ""):
            return None

        # Collapse aliases (twitter.com -> x.com, discord.com/invite -> discord.gg)
        # so the same account found twice dedupes to one row.
        canonical_host = spec.get("host", bare)
        canonical_path = handle if spec.get("canon") == "handle" else match.group(0).lstrip("/")
        return spec["name"], handle, urlunparse(("https", canonical_host, "/" + canonical_path, "", "", ""))
    return None


def site_tokens(base: str):
    """Words from the site's domain, used to spot a matching handle."""
    host = urlparse(base).netloc.lower().split(":")[0].removeprefix("www.")
    label = host.split(".")[0]
    return {label, label.replace("-", ""), label.replace("-", "_")}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--base", required=True, help="URL the HTML was fetched from")
    ap.add_argument("--all", action="store_true",
                    help="keep weak matches too (every handle the page mentions)")
    ap.add_argument("--all-links", action="store_true",
                    help="also list off-site hosts that matched no platform")
    args = ap.parse_args()

    markup = sys.stdin.read()
    tokens = site_tokens(args.base)
    site_host = urlparse(args.base).netloc.lower().removeprefix("www.")

    found, unknown = {}, set()
    for url, strong in candidate_urls(markup, args.base):
        hit = classify(url)
        if not hit:
            if args.all_links:
                host = urlparse(url).netloc.lower().removeprefix("www.")
                if host and host != site_host:
                    unknown.add(f"https://{host}/")
            continue

        platform, handle, canonical = hit
        # A handle that echoes the domain is the site's own account even when it
        # only ever appears mid-page.
        owned = handle.lstrip("@").lower().replace("-", "") in {t.replace("-", "") for t in tokens}
        entry = found.setdefault(canonical, {
            "platform": platform, "handle": handle, "url": canonical,
            "confidence": "low", "hits": 0,
        })
        entry["hits"] += 1
        if strong or owned:
            entry["confidence"] = "high"

    profiles = [p for p in found.values() if args.all or p["confidence"] == "high"]
    profiles.sort(key=lambda p: (p["platform"], len(p["handle"]), p["url"]))

    result = {"source": args.base, "profiles": profiles}
    if args.all_links:
        result["unclassified"] = sorted(unknown)
    json.dump(result, sys.stdout, indent=2)
    print()


if __name__ == "__main__":
    main()
