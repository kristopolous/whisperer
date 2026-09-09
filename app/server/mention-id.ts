/** A mention's identity is its URL.
 *
 *  Ids used to be minted with `randomUUID()` on every run, which made them
 *  meaningless the moment anything re-ran. Issues cite mentions by id, so
 *  re-running discovery — which is what "search this source harder" does —
 *  silently orphaned the provenance of every defect already triaged: the
 *  threads were still in the corpus, under new ids, and the Source panel went
 *  blank. Nothing errored, because nothing was wrong except that the numbers no
 *  longer referred to anything.
 *
 *  Derived from the URL instead, so the same thread is the same id across
 *  reruns, across scans, and across companies. That also makes citations
 *  comparable between observations, which is what the series needs to follow a
 *  defect over time.
 *
 *  Canonicalised first, because the same thread arrives with different spelling
 *  from different providers: a tracking parameter, a trailing slash, `old.` or
 *  `www.` on the front. Two ids for one thread is the same bug in a quieter
 *  form.
 */

import { createHash } from 'node:crypto';

/** Query parameters that identify the page, kept when present. Everything else
 *  is a campaign tag or a session token and is dropped. */
const MEANINGFUL = new Set(['id', 'v', 'p', 'q', 't', 'story_fbid', 'comment']);

export function canonicalUrl(raw: string): string {
  try {
    const url = new URL(raw.trim());
    const host = url.hostname.toLowerCase()
      .replace(/^www\./, '')
      // Reddit serves one thread on three hostnames.
      .replace(/^(old|new|np|amp)\.reddit\.com$/, 'reddit.com');
    const path = url.pathname.replace(/\/+$/, '').toLowerCase() || '/';
    const kept = [...url.searchParams.entries()]
      .filter(([key]) => MEANINGFUL.has(key.toLowerCase()))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key.toLowerCase()}=${value}`)
      .join('&');
    return `${host}${path}${kept ? `?${kept}` : ''}`;
  } catch {
    return raw.trim().toLowerCase();
  }
}

/** The stable id for a mention at this URL. */
export const mentionId = (url: string): string =>
  createHash('sha1').update(canonicalUrl(url)).digest('hex').slice(0, 8);
