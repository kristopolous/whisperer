/** Hacker News, read from its own index rather than through a search engine.
 *
 *  Every other venue here is reached by asking Brave for `site:news.ycombinator.com
 *  "gimp"` and taking what a general-purpose ranker decides to surface. HN
 *  publishes its full corpus through Algolia, free and without a key, with an
 *  exact date sort and an exact date filter — so for this one venue there is no
 *  reason to guess at what a crawler happened to index. Asked directly, "gimp"
 *  returns eleven thousand comments; the search-engine route returned a couple
 *  of dozen links, most of them front pages.
 *
 *  Two things learned by measuring rather than reading:
 *
 *  Algolia is not a boolean engine. `"gimp" (sucks OR terrible)` returns zero
 *  hits — `OR` is matched as a word. So the query is the brand alone and the
 *  complaint filtering happens here, against the same vocabulary the search
 *  path uses. That is strictly better: it costs no requests, it is
 *  deterministic, and every comment is classified by the same rule.
 *
 *  `search_by_date` without `advancedSyntax` and without restricting the
 *  searchable attributes is nearly useless — it returns the whole firehose in
 *  date order, and the query barely filters. The first attempt returned 3.4
 *  million "hits" for gimp, none of the visible ones about GIMP. Quoting the
 *  phrase and restricting the attribute takes that to 11,906 real ones.
 */

import { randomUUID } from 'node:crypto';
import type { Mention } from '../../shared/types.ts';
import { cached, HOUR } from '../cache.ts';
import { complaintLanguage } from '../search.ts';

const ENDPOINT = 'https://hn.algolia.com/api/v1/search_by_date';
/** Algolia's maximum page size, and worth taking all of it.
 *
 *  This was 100 on the reasoning that a page of a hundred is more than the
 *  model will read. That confused two different budgets: the model reads a
 *  ranked selection, and the size of the pool it selects from is set here. HN
 *  holds 621 comments about Lovable in the past year and 933 about GIMP, and a
 *  hundred-item page took a quarter of them — for the same single request that
 *  would have returned the lot. The page size is free; only requests are
 *  rationed, and Algolia charges nothing and asks for no key. */
const PER_PAGE = 1_000;
const TTL = 6 * HOUR;

interface Hit {
  objectID: string;
  created_at: string;
  author: string | null;
  comment_text?: string | null;
  story_text?: string | null;
  title?: string | null;
  story_title?: string | null;
  url?: string | null;
  points?: number | null;
  num_comments?: number | null;
}

/** HN comment bodies are HTML fragments — <p>, <i>, <a> and entities. */
function plain(html: string): string {
  return html
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#x2F;/g, '/')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

async function page(
  brand: string, tags: string, attributes: string, sinceEpoch: number | null, index: number,
): Promise<Hit[]> {
  const params = new URLSearchParams({
    query: `"${brand}"`,
    advancedSyntax: 'true',
    restrictSearchableAttributes: attributes,
    tags,
    hitsPerPage: String(PER_PAGE),
    page: String(index),
  });
  if (sinceEpoch) params.set('numericFilters', `created_at_i>${sinceEpoch}`);

  const key = params.toString();
  return cached('hn', key, TTL, async () => {
    const response = await fetch(`${ENDPOINT}?${key}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'whisperer' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`hn algolia ${response.status}`);
    const body = (await response.json()) as { hits?: Hit[] };
    return body.hits ?? [];
  });
}

export interface HnOptions {
  /** Only comments and stories newer than this many days. Null for all time. */
  days?: number | null;
  /** How many to bring back, across both comments and stories. */
  limit?: number;
}

/** Comments and stories mentioning the brand, newest first.
 *
 *  Comments come first and get most of the budget: a story is usually a link to
 *  something the company published, and the comments under it are where people
 *  say what they think of it. */
export async function searchHackerNews(
  brand: string, emit: (level: 'info' | 'warn', text: string) => void, options: HnOptions = {},
): Promise<Mention[]> {
  const days = options.days === undefined ? 365 : options.days;
  const since = days ? Math.floor(Date.now() / 1000) - days * 86_400 : null;
  // Everything the window holds, rather than a slice of it. A busy subject
  // yields several hundred; a quiet one yields what it yields, and asking for
  // more costs nothing extra.
  const limit = options.limit ?? 1_000;

  const collected: Mention[] = [];
  const seen = new Set<string>();

  const passes: { tags: string; attributes: string; want: number }[] = [
    { tags: 'comment', attributes: 'comment_text', want: Math.ceil(limit * 0.75) },
    { tags: 'story', attributes: 'title,story_text', want: limit - Math.ceil(limit * 0.75) },
  ];

  for (const pass of passes) {
    for (let index = 0; index * PER_PAGE < pass.want; index += 1) {
      let hits: Hit[];
      try {
        hits = await page(brand, pass.tags, pass.attributes, since, index);
      } catch (error) {
        emit('warn', `hacker news ${pass.tags} page ${index} failed — ${
          error instanceof Error ? error.message : String(error)}`);
        break;
      }
      if (hits.length === 0) break;

      for (const hit of hits) {
        if (seen.has(hit.objectID)) continue;
        seen.add(hit.objectID);
        const text = plain(hit.comment_text ?? hit.story_text ?? '');
        const title = plain(hit.story_title ?? hit.title ?? '') || '(Hacker News)';
        // A comment with no text is a deleted one. It is still in the index and
        // carries no opinion, so it must not take a slot in the corpus.
        if (!text && pass.tags === 'comment') continue;

        collected.push({
          id: randomUUID().slice(0, 8),
          venue: 'hackernews',
          title,
          url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
          date: hit.created_at ?? null,
          author: hit.author ?? null,
          excerpt: (text || title).slice(0, 1_200),
          engagement: hit.points ?? hit.num_comments ?? null,
          sentiment: 'neutral',
          score: 0,
          themes: [],
          // A comment is somebody talking, which is the whole point of this
          // source — never a listing or a roundup.
          discussion: true,
          complaint: complaintLanguage(`${title} ${text}`),
        });
      }
      if (hits.length < PER_PAGE) break;
    }
  }

  const ordered = collected.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')).slice(0, limit);
  emit('info', `hacker news: ${ordered.length} items (${ordered.filter((m) => m.complaint).length} complaint-shaped)`
    + (days ? `, last ${days} days` : ', all time'));
  return ordered;
}
