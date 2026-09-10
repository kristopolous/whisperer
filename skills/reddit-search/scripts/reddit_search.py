#!/usr/bin/env python3
"""Search Reddit for a company's discussion and emit it as JSON mentions.

Credentials arrive via environment variables (never argv):
  REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME,
  REDDIT_PASSWORD, REDDIT_USER_AGENT

Usage:
  reddit_search.py --query "truefoundry" [--limit N] [--test]

Writes one JSON object to stdout of the shape:
  {"ok": true, "mentions": [{ "venue", "title", "url", "author",
      "date", "excerpt", "engagement", "commentText" }, ...]}
On failure: {"ok": false, "error": "..."}
"""

import argparse
import json
import os
import re
import sys


# Reddit allows a registered script app 100 requests per minute, averaged over a
# ten-minute window, and answers abuse with a throttle before it answers it with
# a revoked token. One request per second keeps us at 60/min — comfortably under
# without being so slow that a scan notices.
MIN_INTERVAL = float(os.environ.get("REDDIT_MIN_INTERVAL", "1.0"))
_last_request = [0.0]


def paced():
    """Sleep until at least MIN_INTERVAL has passed since the last call.

    PRAW does not pace anything on its own — it reacts to a ratelimit response
    once one arrives, which is already too late to be polite. This is the only
    thing standing between a scan and a burst.
    """
    import time
    wait = MIN_INTERVAL - (time.monotonic() - _last_request[0])
    if wait > 0:
        time.sleep(wait)
    _last_request[0] = time.monotonic()


def make_reddit():
    try:
        import praw
    except ImportError as exc:
        # Naming the interpreter matters more than naming the package. On a
        # Debian host the system python refuses installs (PEP 668), so the
        # obvious `pip install praw` fails, and a venv made afterwards is
        # invisible unless the server is told to use it. Both halves, here,
        # because seeing only one of them costs an hour.
        raise RuntimeError(
            "praw is not installed for %s. Create a virtualenv beside the "
            "checkout and install into it:\n"
            "    python3 -m venv .venv && .venv/bin/pip install praw\n"
            "The server picks up .venv/bin/python3 automatically; set "
            "WHISPERER_PYTHON to use an interpreter elsewhere." % sys.executable
        ) from exc

    return praw.Reddit(
        client_id=os.environ.get("REDDIT_CLIENT_ID", ""),
        client_secret=os.environ.get("REDDIT_CLIENT_SECRET", ""),
        username=os.environ.get("REDDIT_USERNAME", ""),
        password=os.environ.get("REDDIT_PASSWORD", ""),
        user_agent=os.environ.get(
            "REDDIT_USER_AGENT",
            "whisperer-rep-forensics/1.0 (reputation monitoring)",
        ),
        # Wait out a ratelimit response rather than raising, up to five minutes.
        # Erroring here would send the caller round again, which is the worst
        # possible reaction to being told to slow down.
        ratelimit_seconds=300,
    )


def fetch_mentions(reddit, query, limit, with_comments):
    """Search, then read comments for only the first `with_comments` results.

    Reading comments used to happen for every single result, and that is where
    the request count came from: one search listing plus one comment-tree fetch
    per submission, so a 25-result search was 26 requests fired back to back.
    The listing already carries the title and the self-text, which is most of
    the signal; the comment thread is a bonus worth having on the handful of
    posts most likely to be read, not on all of them.
    """
    from datetime import datetime, timezone

    mentions = []
    paced()
    submissions = list(reddit.subreddit("all").search(query, sort="new", limit=limit))

    for index, submission in enumerate(submissions):
        top_comments = []
        if index < with_comments:
            try:
                paced()
                submission.comments.replace_more(limit=0)
                top_comments = submission.comments.list()[:3]
            except Exception:
                # A thread that will not load is one missing bonus, not a
                # reason to abandon the rest — or to retry and add load.
                top_comments = []

        excerpt = (submission.selftext or "").strip().replace("\n", " ") or submission.title
        comment_text = " ".join(
            c.body.strip().replace("\n", " ") for c in top_comments if getattr(c, "body", None)
        )

        # The listing hands us the timestamp; dropping it made every Reddit
        # mention undated, so none of them could be placed on a timeline or
        # counted as recent.
        created = getattr(submission, "created_utc", None)
        date = (
            datetime.fromtimestamp(created, tz=timezone.utc).isoformat().replace("+00:00", "Z")
            if created else None
        )

        mentions.append({
            "venue": "reddit",
            "title": submission.title,
            "url": submission.permalink if submission.permalink.startswith("http") else f"https://www.reddit.com{submission.permalink}",
            "author": getattr(submission.author, "name", None),
            "date": date,
            "excerpt": excerpt[:500],
            "engagement": submission.score,
            "commentText": comment_text[:900],
        })
    return mentions


def to_mention(submission, sub=None):
    from datetime import datetime, timezone
    excerpt = (submission.selftext or "").strip().replace("\n", " ") or submission.title
    created = getattr(submission, "created_utc", None)
    return {
        "venue": "reddit",
        "title": submission.title,
        "url": submission.permalink if submission.permalink.startswith("http")
               else f"https://www.reddit.com{submission.permalink}",
        "author": getattr(submission.author, "name", None),
        "date": (datetime.fromtimestamp(created, tz=timezone.utc).isoformat().replace("+00:00", "Z")
                 if created else None),
        "excerpt": excerpt[:500],
        "engagement": submission.score,
        "commentText": "",
        "subreddit": sub or getattr(getattr(submission, "subreddit", None), "display_name", None),
        # From the listing, so ranking threads by busyness costs nothing.
        "engagementComments": getattr(submission, "num_comments", 0),
    }


def find_subreddit(reddit, name):
    """Is there a subreddit dedicated to this product?

    r/gimp and r/replit exist and are where that product's users complain — a
    far better corpus than searching all of Reddit, where the same words are
    mostly other people's. Resolved by asking for it directly and letting a
    404 answer the question; a name search would return lookalikes, and acting
    on a lookalike means reading a different community entirely.
    """
    try:
        paced()
        sub = reddit.subreddit(name)
        # Touching an attribute is what makes PRAW actually fetch it, and what
        # raises if there is no such subreddit.
        if sub.subscribers is None:
            return None
        return sub
    except Exception:
        return None


# How many comments to keep from a thread, best-scored first.
#
# Free. `replace_more(limit=0)` has already fetched the whole tree in the one
# request the thread costs, so taking twelve of a hundred-comment thread and
# discarding the rest bought nothing — the expensive part already happened. A
# busy r/lovable thread runs to well over a hundred replies and they are the
# substance: the post asks, the thread answers.
PER_THREAD = int(os.environ.get("REDDIT_COMMENTS_PER_THREAD", "60"))


def read_comments(mentions, budget):
    """Expand the busiest threads into their comments, one request each.

    Comments are returned as mentions in their own right rather than glued onto
    the post as a blob of text. The post is usually a question — "black border
    appears when i rotate" — and the thirty replies under it are where the
    experience actually is: the me-toos, the versions it started in, the
    workaround somebody found. Flattened into the parent, all of that arrives as
    one undated, unattributed lump that sentiment scores once and triage reads
    as a single voice.

    Threads are chosen by how many comments they already have, which the listing
    tells us for free. A busy thread is both more likely to hold a real problem
    and a better use of the one request it costs.
    """
    from datetime import datetime, timezone

    ranked = sorted(
        (m for m in mentions if m.get("_submission") is not None),
        key=lambda m: m.get("engagementComments") or 0,
        reverse=True,
    )[:budget]

    out, spent = [], 0
    for m in ranked:
        submission = m["_submission"]
        try:
            paced()
            spent += 1
            submission.comments.replace_more(limit=0)
            comments = [c for c in submission.comments.list() if getattr(c, "body", None)]
        except Exception:
            # One unreadable thread is a missing bonus, not a reason to retry.
            continue

        comments.sort(key=lambda c: getattr(c, "score", 0) or 0, reverse=True)
        for c in comments[:PER_THREAD]:
            body = c.body.strip()
            # Deleted, removed and one-word agreement carry nothing to triage.
            if len(body) < 40 or body in ("[deleted]", "[removed]"):
                continue
            # A bare link is not a sentence. The top-scoring comment on one
            # thread was a preview.redd.it URL and nothing else — it sorts high
            # because people upvote the screenshot, and it says nothing a model
            # can read.
            without_links = re.sub(r"https?://\S+", "", body).strip()
            if len(without_links) < 40:
                continue
            created = getattr(c, "created_utc", None)
            out.append({
                "venue": "reddit",
                # The parent's title is the context a comment needs to be
                # readable on its own in a list.
                "title": f"{m['title']} — comment",
                "url": f"https://www.reddit.com{c.permalink}",
                "author": getattr(getattr(c, "author", None), "name", None),
                "date": (datetime.fromtimestamp(created, tz=timezone.utc).isoformat().replace("+00:00", "Z")
                         if created else m.get("date")),
                "excerpt": body[:900],
                "engagement": getattr(c, "score", None),
                "commentText": "",
                "subreddit": m.get("subreddit"),
                "listing": "comment",
            })
    return out, spent


# A subreddit whose most recent post is older than this is abandoned, and its
# `hot` listing is a museum rather than a signal.
STALE_DAYS = int(os.environ.get("REDDIT_STALE_DAYS", "60"))

# `hot` ranks by current attention, but a pinned announcement or an evergreen
# thread can sit in it for years — r/GimpTutorials still lists a post from 2014.
# One such post stretched a corpus that was otherwise days old across a decade,
# which then chose the wrong granularity for every chart drawn from it. `new` is
# unfiltered: there, an old post genuinely means nothing newer exists.
HOT_MAX_DAYS = int(os.environ.get("REDDIT_HOT_MAX_DAYS", "365"))


def older_than(submission, days):
    from datetime import datetime, timezone
    created = getattr(submission, "created_utc", 0) or 0
    if not created:
        return False
    return (datetime.now(timezone.utc).timestamp() - created) / 86400 > days


def fetch_subreddit(reddit, name, limit):
    """Hot and new from a product's own subreddit, if the subreddit is alive.

    Both listings, because they answer different questions: `new` is what is
    happening now and `hot` is what the community actually cares about, which
    for a complaint corpus is the difference between a passing gripe and one
    that thirty people turned up to agree with.

    `new` is fetched FIRST, and that ordering is the point. A product often has
    abandoned spin-off subreddits alongside its real one — r/GIMP is busy, while
    r/GIMPArt last saw a post in 2021 and r/GimpTutorials in 2014 — and their
    `hot` listings are twenty-five years-old posts apiece. Pulled in, they
    swamped a corpus that was otherwise hours old and made the whole timeline
    look like it spanned a decade. Checking the newest post first answers "is
    anybody still here" for one request, and a dead subreddit costs nothing
    further.
    """
    from datetime import datetime, timezone

    sub = find_subreddit(reddit, name)
    if sub is None:
        return [], 1, None

    out, requests = [], 1

    try:
        paced()
        requests += 1
        newest = list(sub.new(limit=limit))
    except Exception:
        return [], requests, None

    if not newest:
        return [], requests, None

    latest = max((getattr(s, "created_utc", 0) or 0) for s in newest)
    age_days = (datetime.now(timezone.utc).timestamp() - latest) / 86400
    if age_days > STALE_DAYS:
        # Abandoned. Do not spend a request on its `hot`, and do not return its
        # `new` either — the most recent thing here is still ancient.
        return [], requests, None

    for submission in newest:
        out.append({**to_mention(submission, sub.display_name),
                    "listing": "new", "_submission": submission})

    # `top` over the last month is the third question, and the most useful one
    # for a complaint corpus: not what was posted, and not what is busy right
    # now, but what the community actually voted up over a window. A problem
    # thirty people upvoted is a different weight of evidence from one nobody
    # replied to — and the window bounds it, so unlike `hot` it cannot surface
    # a pinned post from 2014.
    # `top` before `hot`, and both after `new` only because `new` establishes
    # liveness. Where a post appears in more than one listing the first label
    # wins, so ordering these decides what a row is called rather than whether
    # it is collected.
    for listing, fetch in (
        ("top", lambda n: sub.top(time_filter="month", limit=n)),
        ("hot", sub.hot),
    ):
        try:
            paced()
            requests += 1
            for submission in fetch(limit=limit):
                if listing == "hot" and older_than(submission, HOT_MAX_DAYS):
                    continue
                out.append({**to_mention(submission, sub.display_name),
                            "listing": listing, "_submission": submission})
        except Exception:
            continue

    return out, requests, sub.display_name


def fetch_page(reddit, url):
    """One submission and its comments, by URL.

    Reddit blocks this network on every unauthenticated route, so reading a
    thread found in the corpus went to the metered scraper — for a site we now
    hold API credentials to. This is the same content for free, and it comes
    back structured rather than as scraped HTML.
    """
    from datetime import datetime, timezone

    paced()
    submission = reddit.submission(url=url)
    parts = [submission.title, (submission.selftext or "").strip()]
    # The post's own timestamp. A thread reached through a web search arrives
    # with whatever date the search engine guessed, which is usually none — and
    # reddit is half the corpus, so those undated rows are most of what keeps
    # the timeline from being trustworthy. It is already on the object.
    created = getattr(submission, "created_utc", None)
    when = (
        datetime.fromtimestamp(created, tz=timezone.utc).isoformat()
        if created
        else None
    )
    try:
        paced()
        submission.comments.replace_more(limit=0)
        for c in submission.comments.list()[:40]:
            body = getattr(c, "body", None)
            if body:
                parts.append(body.strip())
    except Exception:
        pass
    return "\n\n".join(p for p in parts if p), 2, when


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--query", default="")
    # Read one thread instead of searching. Mutually exclusive with --query in
    # practice; the caller picks a mode.
    parser.add_argument("--url", default="")
    # Candidate names for a dedicated subreddit, most likely first. Each one
    # that does not exist costs a single request to find out.
    parser.add_argument("--subs", default="")
    # How many items to take from each listing. PRAW paginates transparently
    # above 100, spending one request per further page — so 500 is five
    # requests, not five hundred. Reddit stops a listing at about 1,000
    # whatever you ask for.
    parser.add_argument("--limit", type=int, default=500)
    # How many of those results get their comment thread read. Each one is a
    # separate request, so this is the number that decides how hard we lean on
    # the API.
    parser.add_argument("--with-comments", type=int, default=25)
    # Stop early once the corpus is big enough to say something. Sampling a
    # busy subreddit is cheap; sampling it forever is not, and past a point
    # another hundred posts changes no conclusion.
    parser.add_argument("--target", type=int, default=0)
    args = parser.parse_args()

    try:
        reddit = make_reddit()
    except RuntimeError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        sys.exit(0)

    if args.url:
        try:
            text, cost, when = fetch_page(reddit, args.url)
            print(json.dumps({"ok": True, "text": text, "requests": cost, "date": when}))
        except Exception as exc:  # noqa: BLE001
            print(json.dumps({"ok": False, "error": str(exc)}))
        sys.exit(0)

    if not args.query:
        print(json.dumps({"ok": False, "error": "one of --query or --url is required"}))
        sys.exit(0)

    try:
        mentions, requests, subs = [], 0, []
        seen = set()

        # The dedicated subreddit first: it is the better corpus, and doing it
        # first means the site-wide sweep mostly finds things already collected,
        # which dedupe then drops for free.
        for candidate in [c.strip() for c in args.subs.split(",") if c.strip()]:
            if args.target and len(mentions) >= args.target:
                break
            remaining = max(0, args.target - len(mentions)) if args.target else args.limit
            found, cost, name = fetch_subreddit(
                reddit, candidate, min(args.limit, remaining) if args.target else args.limit,
            )
            requests += cost
            if name:
                subs.append(name)
            for m in found:
                if m["url"] not in seen:
                    seen.add(m["url"])
                    mentions.append(m)

        # The comment budget goes to the product's own subreddit when there is
        # one. Measured on GIMP: r/GIMP produced seventeen posts that were all
        # about the software, while the site-wide sweep produced thirteen that
        # were mostly about something else entirely — "gimp" is an ordinary
        # English word, and r/all does not know which one is meant. Spending
        # five requests reading comment threads under the wrong posts is the
        # worst of both: it costs the most and returns the least.
        if subs:
            expanded, cost = read_comments(mentions, args.with_comments)
            requests += cost
            for c in expanded:
                if c["url"] not in seen:
                    seen.add(c["url"])
                    mentions.append(c)
            sweep_comments = 0
        else:
            sweep_comments = args.with_comments

        swept = fetch_mentions(reddit, args.query, args.limit, sweep_comments)
        requests += 1 + min(sweep_comments, len(swept))
        for m in swept:
            if m["url"] not in seen:
                seen.add(m["url"])
                mentions.append(m)

        for m in mentions:
            m.pop("_submission", None)   # not serialisable, and not the caller's business
            m.pop("engagementComments", None)
        print(json.dumps({"ok": True, "mentions": mentions, "requests": requests, "subreddits": subs}))
    except Exception as exc:  # noqa: BLE001 - report the Reddit error back to the server
        print(json.dumps({"ok": False, "error": str(exc)}))
        sys.exit(0)


if __name__ == "__main__":
    main()
