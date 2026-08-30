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
import sys


def make_reddit():
    try:
        import praw
    except ImportError as exc:
        raise RuntimeError("praw is not installed: run `pip install praw` (see data-reddit.txt)") from exc

    return praw.Reddit(
        client_id=os.environ.get("REDDIT_CLIENT_ID", ""),
        client_secret=os.environ.get("REDDIT_CLIENT_SECRET", ""),
        username=os.environ.get("REDDIT_USERNAME", ""),
        password=os.environ.get("REDDIT_PASSWORD", ""),
        user_agent=os.environ.get(
            "REDDIT_USER_AGENT",
            "whisperer-rep-forensics/1.0 (reputation monitoring)",
        ),
    )


def fetch_mentions(reddit, query, limit):
    mentions = []
    for submission in reddit.subreddit("all").search(query, sort="new", limit=limit):
        try:
            submission.comments.replace_more(limit=0)
            top_comments = submission.comments.list()[:3]
        except Exception:
            top_comments = []

        excerpt = (submission.selftext or "").strip().replace("\n", " ") or submission.title
        comment_text = " ".join(
            c.body.strip().replace("\n", " ") for c in top_comments if getattr(c, "body", None)
        )

        mentions.append({
            "venue": "reddit",
            "title": submission.title,
            "url": submission.permalink if submission.permalink.startswith("http") else f"https://www.reddit.com{submission.permalink}",
            "author": getattr(submission.author, "name", None),
            "date": None,
            "excerpt": excerpt[:500],
            "engagement": submission.score,
            "commentText": comment_text[:900],
        })
    return mentions


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--query", required=True)
    parser.add_argument("--limit", type=int, default=8)
    args = parser.parse_args()

    try:
        reddit = make_reddit()
    except RuntimeError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        sys.exit(0)

    try:
        mentions = fetch_mentions(reddit, args.query, args.limit)
        print(json.dumps({"ok": True, "mentions": mentions}))
    except Exception as exc:  # noqa: BLE001 - report the Reddit error back to the server
        print(json.dumps({"ok": False, "error": str(exc)}))
        sys.exit(0)


if __name__ == "__main__":
    main()
