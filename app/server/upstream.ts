/** Defects the project already knows about, from its own issue tracker.
 *
 *  Everything else in this pipeline reconstructs a defect from strangers
 *  complaining in public — which is the hard case, and the interesting one. But
 *  a project's own tracker is full of reports that are already written up, with
 *  reproduction steps, versions and a maintainer's labels on them. Ignoring
 *  that because it is easy would be silly.
 *
 *  They enter as ordinary mentions rather than as ready-made issues, on
 *  purpose. Triage then has both halves in front of it and can merge them: four
 *  people grumbling on Reddit and one filed bug describing the same crash is one
 *  issue with five pieces of evidence, and knowing there is already a ticket
 *  changes what you do about it. Passing them straight through as issues would
 *  produce a list that double-counts every defect the public also discusses.
 *
 *  Read-only and unauthenticated by default. A token raises the rate limit and
 *  nothing else.
 */

import { randomUUID } from 'node:crypto';
import type { Mention } from '../shared/types.ts';
import { cached, HOUR } from './cache.ts';
import { cleanText } from '../shared/html.ts';
import { secret } from './secrets.ts';

interface Upstream {
  host: 'github' | 'gitlab' | 'bugzilla';
  /** API endpoint listing open issues, newest first. */
  url: string;
  /** Where a human would read them. */
  web: string;
}

/** Work out which tracker a URL belongs to, and how to ask it.
 *
 *  Takes either a clone URL or a tracker URL. A repository host implies its own
 *  tracker, but plenty of projects keep the two apart — Bugzilla is a separate
 *  service that no clone URL will ever point at, so `config/repos.json` can
 *  name one explicitly.
 *
 *  A Bugzilla URL is expected to carry its own query: which product, and what
 *  counts as open. Guessing a product name from a company name would be wrong
 *  more often than right — "GIMP" happens to match, "Firefox" under a company
 *  called Mozilla does not. */
export function upstreamFor(repoUrl: string, limit: number): Upstream | null {
  try {
    const parsed = new URL(repoUrl.replace(/\.git$/, ''));

    if (/bugzilla|^bugs\./i.test(parsed.hostname) || parsed.pathname.includes('/rest/bug')) {
      const query = new URLSearchParams(parsed.search);
      if (!query.has('resolution')) query.set('resolution', '---');

      // Recency comes from a date filter, not from `order`.
      //
      // `order=creation_time DESC` is what everyone recommends, but it is an
      // undocumented parameter and not every Bugzilla honours it — KDE's
      // silently ignores it and returns oldest-first, so a search for "recent
      // bugs" came back with wishlist items from 2005. `creation_time` is
      // documented, is respected, and combined with sorting the results
      // ourselves it does not depend on the server obliging at all.
      if (!query.has('creation_time')) {
        const since = new Date(Date.now() - RECENT_BUG_DAYS * 86_400_000);
        query.set('creation_time', since.toISOString().slice(0, 10));
      }
      // Over-fetch so the newest survive the client-side sort and the
      // feature-request filter below.
      query.set('limit', String(limit * 6));
      const search = query.toString().replace(/\+/g, '%20');
      return {
        host: 'bugzilla',
        url: `${parsed.origin}/rest/bug?${search}`,
        web: `${parsed.origin}/buglist.cgi`,
      };
    }
    const path = parsed.pathname.replace(/^\/+|\/+$/g, '');
    if (!path.includes('/')) return null;

    if (/(^|\.)github\.com$/i.test(parsed.hostname)) {
      return {
        host: 'github',
        url: `https://api.github.com/repos/${path}/issues?state=open&sort=created&direction=desc&per_page=${limit}`,
        web: `https://github.com/${path}/issues`,
      };
    }

    // Any GitLab instance, not just gitlab.com — GIMP's lives on
    // gitlab.gnome.org, and self-hosted GitLab is common for exactly the kind
    // of project that has a long-lived public tracker.
    return {
      host: 'gitlab',
      url: `${parsed.origin}/api/v4/projects/${encodeURIComponent(path)}/issues`
        + `?state=opened&order_by=created_at&sort=desc&per_page=${limit}`,
      web: `${parsed.origin}/${path}/-/issues`,
    };
  } catch {
    return null;
  }
}

/** How far back a Bugzilla search reaches. A tracker that has been open for
 *  twenty years is mostly archaeology; what matters is what is being filed now. */
const RECENT_BUG_DAYS = Number(process.env.RECENT_BUG_DAYS ?? 180);

/** Labels that mark a report as a defect rather than a wish or a discussion.
 *  Matched loosely because every project spells them differently. */
const DEFECT_LABEL = /\b(bug|crash|defect|regression|error|broken|fault)\b/i;
const NOT_DEFECT_LABEL = /\b(feature|enhancement|proposal|discussion|question|documentation|design|wishlist|rfe)\b/i;

interface RawBug {
  id?: number;
  summary?: string;
  creation_time?: string;
  severity?: string;
  status?: string;
  component?: string;
  product?: string;
  creator?: string;
  keywords?: string[];
}

interface RawIssue {
  title?: string;
  body?: string | null;
  description?: string | null;
  html_url?: string;
  web_url?: string;
  created_at?: string;
  user?: { login?: string };
  author?: { username?: string };
  labels?: (string | { name?: string })[];
  pull_request?: unknown;
  comments?: number;
  user_notes_count?: number;
}

const labelNames = (issue: RawIssue): string[] =>
  (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name ?? '')).filter(Boolean);

/** Open issues from the project's own tracker, as mentions.
 *
 *  Cached for an hour: a tracker does not turn over fast enough to be worth
 *  re-fetching on every rerun of a stage. */
export async function fetchUpstreamIssues(
  repoUrl: string,
  emit: (level: 'info' | 'warn', text: string) => void,
  limit = 50,
): Promise<Mention[]> {
  const upstream = upstreamFor(repoUrl, limit);
  if (!upstream) {
    emit('warn', `cannot work out an issue tracker for ${repoUrl}`);
    return [];
  }

  const token = upstream.host === 'github' ? secret('GITHUB_TOKEN') : secret('GITLAB_TOKEN');

  let rows: RawIssue[];
  try {
    rows = await cached(`upstream`, upstream.url, HOUR, async () => {
      const response = await fetch(upstream.url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'whisperer',
          ...(token
            ? upstream.host === 'github'
              ? { Authorization: `Bearer ${token}` }
              : { 'PRIVATE-TOKEN': token }
            : {}),
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new Error(`${upstream.host} ${response.status} — ${(await response.text()).slice(0, 120)}`);
      }
      const parsed = await response.json();
      // Bugzilla answers { bugs: [...] }; the git hosts answer a bare array.
      if (Array.isArray(parsed)) return parsed as RawIssue[];
      const bugs = (parsed as { bugs?: RawBug[] }).bugs ?? [];
      const origin = new URL(upstream.url).origin;
      return bugs.map((bug): RawIssue => ({
        title: bug.summary,
        // The list endpoint carries no description — that is a second request
        // per bug — so the summary stands in. Bugzilla summaries are unusually
        // informative precisely because that is all most readers see.
        body: [bug.product, bug.component, bug.severity].filter(Boolean).join(' · '),
        html_url: `${origin}/show_bug.cgi?id=${bug.id}`,
        created_at: bug.creation_time,
        user: { login: bug.creator },
        labels: [bug.severity, bug.component, ...(bug.keywords ?? [])].filter(Boolean) as string[],
      }));
    });
  } catch (error) {
    emit('warn', `could not read the ${upstream.host} tracker — ${error instanceof Error ? error.message.slice(0, 120) : 'error'}`);
    return [];
  }

  const issues = rows
    // GitHub returns pull requests from the issues endpoint. A PR is somebody
    // fixing something, not somebody reporting it.
    .filter((issue) => !issue.pull_request)
    .filter((issue) => {
      const labels = labelNames(issue);
      // A defect label settles it. Otherwise keep anything not explicitly
      // labelled as a feature request — most trackers label sparsely, and
      // requiring a "bug" tag would discard most of the real reports.
      if (labels.some((l) => DEFECT_LABEL.test(l))) return true;
      return !labels.some((l) => NOT_DEFECT_LABEL.test(l));
    });

  // Newest first, ours to guarantee rather than the server's to promise.
  issues.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));

  const mentions: Mention[] = issues.slice(0, limit).map((issue) => {
    const url = issue.html_url ?? issue.web_url ?? upstream.web;
    const body = cleanText(String(issue.body ?? issue.description ?? '')).slice(0, 1_200);
    const labels = labelNames(issue);
    return {
      id: randomUUID().slice(0, 8),
      venue: 'github',
      title: cleanText(issue.title ?? '(untitled issue)'),
      url,
      date: issue.created_at ?? null,
      author: issue.user?.login ?? issue.author?.username ?? null,
      excerpt: body || cleanText(issue.title ?? ''),
      engagement: null,
      // Left for the scoring pass like everything else — a filed bug is not
      // automatically a furious one, and pretending to know its sentiment
      // would put a number in front of the model that it did not produce.
      sentiment: 'neutral',
      score: 0,
      themes: labels.slice(0, 3),
      discussion: true,
      // It is a defect report by construction. This is the flag that gets it
      // into the half of the corpus triage actually reads.
      complaint: true,
    };
  });

  emit(
    'info',
    `${mentions.length} open issue(s) from the ${upstream.host} tracker`
    + (rows.length > mentions.length ? ` (${rows.length - mentions.length} skipped as pull requests or feature requests)` : ''),
  );
  return mentions;
}
