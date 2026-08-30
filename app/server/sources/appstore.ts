/** App Store reviews: people complaining about the product, with a star rating
 *  and a version number attached.
 *
 *  Free, no key, no scraping — Apple publishes customer reviews as JSON. For
 *  anything with an iOS app this is the densest complaint source available: the
 *  writers are all users, they are all talking about the product itself, every
 *  one is dated, and a one-star review is a complaint by definition rather than
 *  by inference. The most recent page for Replit opens with
 *  "Great at First, but Now Expensive and Frustrating".
 *
 *  `im:version` is the part that makes these worth more than a forum post for
 *  triage: a cluster of one-star reviews that all name the same build is a
 *  regression with a date on it.
 *
 *  ── Picking the right app is the whole risk here ────────────────────────────
 *
 *  A search for "bolt" returns Bolt: Request a Ride (bolt.eu), Bolt Browser
 *  (boltbrowser.app) and Bolt Food — three unrelated companies, all with
 *  hundreds of thousands of ratings. Guessing wrong does not produce an empty
 *  panel, it produces a full one about somebody else, which is far worse: every
 *  number downstream is confidently derived from the wrong company's users.
 *
 *  So the match is made on `sellerUrl` against the site the scan already
 *  resolved, not on the name. If there is no site to check against, or nothing
 *  published by that host, this returns nothing and says so. A brand that
 *  simply has no iOS app is the common case and must not be talked into one.
 */

import { randomUUID } from 'node:crypto';
import type { Mention } from '../../shared/types.ts';
import { cached, DAY, HOUR } from '../cache.ts';
import { complaintLanguage } from '../search.ts';
import { hostOf } from '../../shared/name.ts';

/** Apple serves ten pages of fifty. */
const MAX_PAGES = 10;

interface App {
  trackId: number;
  trackName: string;
  sellerName?: string;
  sellerUrl?: string;
  averageUserRating?: number;
  userRatingCount?: number;
  trackViewUrl?: string;
}

interface Entry {
  author?: { name?: { label?: string } };
  updated?: { label?: string };
  'im:rating'?: { label?: string };
  'im:version'?: { label?: string };
  id?: { label?: string };
  title?: { label?: string };
  content?: { label?: string };
}

async function get<T>(url: string, ttl: number, namespace: string): Promise<T> {
  return cached(namespace, url, ttl, async () => {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'whisperer' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`itunes ${response.status}`);
    return (await response.json()) as T;
  });
}

/** The subject's own iOS app, identified by who publishes it.
 *
 *  Registrable-domain comparison rather than exact host: an app is routinely
 *  published under `www.` or a marketing subdomain of the same company. Two
 *  labels is the right depth — `replit.com` and `food.bolt.eu` both reduce to
 *  something that can be compared without letting `bolt.eu` match `bolt.new`. */
function publishedBy(app: App, site: string): boolean {
  const registrable = (host: string) => host.split('.').slice(-2).join('.');
  const theirs = registrable(hostOf(app.sellerUrl ?? ''));
  const ours = registrable(hostOf(site));
  return Boolean(theirs) && theirs === ours;
}

export async function findAppStoreApp(
  brand: string, site: string, emit: (level: 'info' | 'warn', text: string) => void,
): Promise<App | null> {
  if (!site) {
    emit('info', 'app store: no resolved site to match an app against, so not guessing at one');
    return null;
  }

  let results: App[];
  try {
    const params = new URLSearchParams({ term: brand, entity: 'software', limit: '20', country: 'us' });
    ({ results } = await get<{ results: App[] }>(
      `https://itunes.apple.com/search?${params}`, DAY, 'appstore'));
  } catch (error) {
    emit('warn', `app store lookup failed — ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }

  const match = (results ?? []).find((app) => publishedBy(app, site));
  if (!match) {
    const names = (results ?? []).slice(0, 3).map((a) => `${a.trackName} (${hostOf(a.sellerUrl ?? '?')})`);
    emit('info', `app store: nothing published by ${hostOf(site)}`
      + (names.length ? ` — the near misses were ${names.join(', ')}, all somebody else's` : ''));
    return null;
  }

  emit('info', `app store: ${match.trackName} by ${match.sellerName ?? '?'} — `
    + `${match.averageUserRating?.toFixed(2) ?? '?'}/5 over ${match.userRatingCount ?? 0} ratings`);
  return match;
}

/** Recent customer reviews of the subject's iOS app, newest first. */
export async function findAppReviews(
  brand: string, site: string, emit: (level: 'info' | 'warn', text: string) => void,
  limit = 100,
): Promise<Mention[]> {
  const app = await findAppStoreApp(brand, site, emit);
  if (!app) return [];

  const collected: Mention[] = [];
  for (let index = 1; index <= MAX_PAGES && collected.length < limit; index += 1) {
    let entries: Entry[];
    try {
      const body = await get<{ feed?: { entry?: Entry[] } }>(
        `https://itunes.apple.com/us/rss/customerreviews/page=${index}/id=${app.trackId}/sortby=mostrecent/json`,
        6 * HOUR, 'appstore',
      );
      entries = body.feed?.entry ?? [];
    } catch (error) {
      emit('warn', `app store reviews page ${index} failed — ${
        error instanceof Error ? error.message : String(error)}`);
      break;
    }
    // The first entry of page one is the app itself, not a review.
    if (entries.length && !entries[0]!['im:rating']) entries = entries.slice(1);
    if (entries.length === 0) break;

    for (const entry of entries) {
      const rating = Number(entry['im:rating']?.label ?? '0');
      const title = entry.title?.label ?? '';
      const text = entry.content?.label ?? '';
      const version = entry['im:version']?.label;
      if (!title && !text) continue;

      collected.push({
        id: randomUUID().slice(0, 8),
        venue: 'review',
        title: title || `${rating}★ review`,
        url: app.trackViewUrl ?? `https://apps.apple.com/us/app/id${app.trackId}`,
        date: entry.updated?.label ?? null,
        author: entry.author?.name?.label ?? null,
        // The build is carried into the text rather than dropped, because it is
        // the single most useful fact in a review for anybody trying to fix
        // what it describes.
        excerpt: `${rating}★${version ? ` on ${version}` : ''} — ${text}`.slice(0, 1_200),
        engagement: null,
        sentiment: 'neutral',
        score: 0,
        themes: [],
        discussion: true,
        // Three stars or fewer is somebody who is not happy, whatever words
        // they chose. Above that, the language decides — plenty of four-star
        // reviews are a compliment wrapped around a specific defect.
        complaint: rating <= 3 || complaintLanguage(`${title} ${text}`),
      });
      if (collected.length >= limit) break;
    }
  }

  const unhappy = collected.filter((m) => m.complaint).length;
  emit('info', `app store: ${collected.length} recent reviews, ${unhappy} of them unhappy`);
  return collected;
}
