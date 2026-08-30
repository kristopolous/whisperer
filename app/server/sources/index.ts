/** The direct sources — the ones read by asking the venue itself.
 *
 *  A deliberate third category, alongside MCP connectors and write channels,
 *  because it answers a question neither of those does: what is this scan
 *  actually reading, and why is one of them quiet?
 *
 *  These are not connectors. Nothing is brokered, there is no `tools/list` to
 *  probe, and most of them need no credential at all — they are plain HTTP
 *  calls to a published API, which is the point. But "no credential needed" and
 *  "credential missing, so this source contributed nothing" look identical from
 *  the outside, and Reddit spent this project's whole life in the second state
 *  while looking like the first: the code to read it existed, worked, and was
 *  called by nothing.
 *
 *  So each source declares what it needs and whether it has it, the dashboard
 *  renders that as a row, and a source that is dark says so.
 */

import { hasSecret } from '../secrets.ts';
import { hintFor } from '../credential-hints.ts';
import { braveExhausted } from '../search.ts';

/** `exhausted` is its own state, and the reason this enum is not a boolean.
 *
 *  A provider that authenticates perfectly and has no allowance left is not
 *  "ready" and is not "down" — it is configured, working, and contributing
 *  nothing until somebody tops it up or waits for the month to turn. Collapsing
 *  it into either of the others is how Brave spent a day looking healthy while
 *  every search fell through to a backup. */
export type SourceReadiness = 'ready' | 'needs-credentials' | 'exhausted';

export interface DirectSource {
  id: string;
  label: string;
  /** What it contributes that the others do not. */
  notes: string;
  /** Credentials it cannot run without. Empty means it needs none. */
  requires: string[];
  /** Credentials that improve it but are not required — a rate limit, mostly. */
  optional?: string[];
  /** Says whether the provider has told us it is out of allowance, and why.
   *  A function because the answer changes during a run — it is discovered the
   *  first time a request is refused, not read from config. */
  exhausted?: () => string | null;
}

const SOURCES: DirectSource[] = [
  {
    id: 'brave',
    label: 'Brave Search',
    notes:
      'General web search, and the backbone of discovery — every `site:` query goes through it. '
      + 'The free plan allows 2,000 queries a month; past that, searches fall through to whichever '
      + 'connector holds the `search` role.',
    requires: ['BRAVE_API_KEY'],
    // Answered by the provider itself rather than counted here: Brave returns
    // QUOTA_LIMITED with the numbers on it, which beats any local tally.
    exhausted: () => {
      const spent = braveExhausted();
      return spent ? `Brave says this month's 2,000 queries are used up (first seen ${spent.at}).` : null;
    },
  },
  {
    id: 'hackernews',
    label: 'Hacker News',
    notes:
      "Its full comment index through Algolia, newest first, with exact date windows. Asked directly "
      + 'it returns thousands of comments where a `site:` search returns a couple of dozen links.',
    requires: [],
  },
  {
    id: 'github-search',
    label: 'GitHub issue search',
    notes:
      'Issues about the product filed in OTHER repositories — the plugin, the wrapper, the packaging '
      + "repo. The project's own tracker is read separately; these are the reports it never sees.",
    requires: [],
    optional: ['GITHUB_TOKEN'],
  },
  {
    id: 'appstore',
    label: 'App Store reviews',
    notes:
      'Customer reviews of the subject\'s iOS app, dated and star-rated, each naming the build it was '
      + 'written about. Only used when the app is published by the site the scan resolved.',
    requires: [],
  },
  {
    id: 'reddit',
    label: 'Reddit',
    notes:
      "Reddit's own API rather than `site:reddit.com`, which mostly returns the post and rarely the "
      + 'thread under it — and the replies are where people say what actually went wrong.',
    requires: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USERNAME', 'REDDIT_PASSWORD'],
  },
  {
    id: 'trackers',
    label: 'Project trackers',
    notes:
      "The subject's own GitHub, GitLab or Bugzilla tracker, folded into the corpus as mentions so "
      + 'triage can merge a filed bug with the people grumbling about the same thing.',
    requires: [],
    optional: ['GITHUB_TOKEN'],
  },
];

export interface SourceState extends Omit<DirectSource, 'exhausted'> {
  readiness: SourceReadiness;
  missing: string[];
  /** Why it is out, when it is. */
  exhaustedReason?: string;
  /** Where to top it up or check the plan, and where the key is issued. Carried
   *  on the source so "no credits" comes with somewhere to go, rather than
   *  leaving somebody to work out whose dashboard they need. */
  links: { name: string; get?: string; billing?: string }[];
}

export function sourceStates(): SourceState[] {
  return SOURCES.map(({ exhausted, ...source }) => {
    const missing = source.requires.filter((name) => !hasSecret(name));
    const reason = missing.length ? null : exhausted?.() ?? null;
    const links = [...source.requires, ...(source.optional ?? [])].map((name) => {
      const hint = hintFor(name);
      return { name, get: hint.url, billing: hint.billingUrl };
    });
    return {
      ...source,
      missing,
      links,
      ...(reason ? { exhaustedReason: reason } : {}),
      readiness: missing.length ? 'needs-credentials' : reason ? 'exhausted' : 'ready',
    };
  });
}
