/** Issues about the product, filed anywhere on GitHub — not just on its own
 *  tracker.
 *
 *  The tracker ingestion in upstream.ts reads the project's own repository,
 *  which is the obvious half. The other half is that people report a product's
 *  defects wherever they happen to be standing: in the plugin repo, in the
 *  wrapper library, in the packaging repo, in the tool that shells out to it.
 *  A search for "gimp crash" across GitHub returns 1,679 issues, and the top
 *  one is a crash on GIMP 3.2.4 filed in a completely different project.
 *
 *  These are worth more per item than a forum post: somebody who opens an issue
 *  writes a version number and steps. What they do not do is tell the project
 *  they use — which is precisely why nobody at the project ever sees them.
 *
 *  The subject's own repository is excluded here rather than deduplicated
 *  later, because upstream.ts already reads it properly (open issues only, pull
 *  requests filtered out) and a second, worse copy of the same issues would
 *  quietly take slots from everything else.
 */

import { randomUUID } from 'node:crypto';
import { mentionId } from '../mention-id.ts';
import type { Mention } from '../../shared/types.ts';
import { cached, HOUR } from '../cache.ts';
import { complaintLanguage } from '../search.ts';
import { secret } from '../secrets.ts';

const ENDPOINT = 'https://api.github.com/search/issues';
const PER_PAGE = 50;
const TTL = 6 * HOUR;

interface Item {
  html_url: string;
  title: string;
  body: string | null;
  created_at: string;
  user?: { login?: string } | null;
  comments?: number;
  repository_url: string;
  state: string;
  pull_request?: unknown;
}

/** "https://api.github.com/repos/GNOME/gimp" → "gnome/gimp". */
const repoOf = (url: string) => (url.split('/repos/')[1] ?? '').toLowerCase();

async function page(query: string, index: number): Promise<Item[]> {
  const params = new URLSearchParams({
    q: query, sort: 'created', order: 'desc', per_page: String(PER_PAGE), page: String(index),
  });
  const key = params.toString();
  return cached('github-search', key, TTL, async () => {
    // Authenticated when a token is present: unauthenticated issue search is
    // ten requests a minute, which one scan exhausts.
    const token = secret('GITHUB_TOKEN');
    const response = await fetch(`${ENDPOINT}?${key}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'whisperer',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`github search ${response.status}: ${detail.slice(0, 120)}`);
    }
    const body = (await response.json()) as { items?: Item[] };
    return body.items ?? [];
  });
}

export interface GithubSearchOptions {
  /** The subject's own repository as `owner/name`, so it can be left out. */
  ownRepo?: string | null;
  limit?: number;
}

/** Issues mentioning the brand, from across GitHub, newest first. */
export async function searchGithubIssues(
  brand: string,
  emit: (level: 'info' | 'warn', text: string) => void,
  options: GithubSearchOptions = {},
): Promise<Mention[]> {
  const limit = options.limit ?? 300;
  const own = (options.ownRepo ?? '').toLowerCase();

  // The phrase is quoted so a two-word brand is matched as a phrase, and the
  // search is confined to issues — GitHub counts pull requests as issues on
  // this endpoint, and a dependency bump that happens to name the product is
  // not somebody reporting anything.
  const query = `"${brand}" in:title,body is:issue`;

  const collected: Mention[] = [];
  const seen = new Set<string>();
  let skippedOwn = 0;

  for (let index = 1; collected.length < limit; index += 1) {
    let items: Item[];
    try {
      items = await page(query, index);
    } catch (error) {
      emit('warn', `github issue search page ${index} failed — ${
        error instanceof Error ? error.message : String(error)}`);
      break;
    }
    if (items.length === 0) break;

    for (const item of items) {
      if (item.pull_request) continue;
      const repo = repoOf(item.repository_url);
      if (own && repo === own) { skippedOwn += 1; continue; }
      if (seen.has(item.html_url)) continue;
      seen.add(item.html_url);

      const body = (item.body ?? '').replace(/\s+/g, ' ').trim();
      collected.push({
        id: mentionId(item.html_url),
        venue: 'github',
        title: `${repo}: ${item.title}`.slice(0, 200),
        url: item.html_url,
        date: item.created_at ?? null,
        author: item.user?.login ?? null,
        excerpt: (body || item.title).slice(0, 1_200),
        engagement: item.comments ?? null,
        sentiment: 'neutral',
        score: 0,
        themes: [],
        discussion: true,
        // Somebody opened an issue about it. That is a report by construction,
        // whatever register they wrote it in — the language test only decides
        // whether it also reads as a gripe, and either way it belongs in the
        // half of the corpus triage reads.
        complaint: true,
      });
      if (collected.length >= limit) break;
    }
    if (items.length < PER_PAGE) break;
  }

  emit(
    'info',
    `github issue search: ${collected.length} issues in other repositories`
    + (skippedOwn ? ` (${skippedOwn} skipped as the project's own tracker, already read)` : '')
    + ` — ${collected.filter((m) => complaintLanguage(m.excerpt)).length} worded as complaints`,
  );
  return collected;
}
