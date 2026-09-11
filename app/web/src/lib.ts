import type { Mention, Scan, Venue } from '../../shared/types.ts';
import { cleanName, hostOf, looksLikeHost, siteOf } from '../../shared/name.ts';

export { cleanName, hostOf, looksLikeHost, siteOf };

/** Older stored scans (and a fresh blank) may lack the newer collection/object
 *  fields. Fill them so every tab can read `.length` / `.map` without a guard. */
export function normalize(scan: Scan): Scan {
  return {
    ...scan,
    company: looksLikeHost(scan.company) ? cleanName(scan.company) : scan.company,
    profiles: (scan.profiles ?? []).map((p) => ({ ...p, official: p.official ?? true, confidence: p.confidence ?? 'low' })),
    // Scans stored before the flag existed get the benefit of the doubt; they
    // were ranked discussion-first anyway.
    mentions: (scan.mentions ?? []).map((m) => ({ ...m, discussion: m.discussion ?? true })),
    issues: scan.issues ?? [],
    abuse: scan.abuse ?? [],
    buzz: scan.buzz ?? [],
    topics: scan.topics ?? [],
    migrations: scan.migrations ?? [],
    reviews: scan.reviews ?? [],
    feed: scan.feed ?? [],
    log: scan.log ?? [],
    timings: scan.timings ?? {},
    net: scan.net ?? { now: 0, delta: 0 },
  };
}


/** Venue → categorical slot. Fixed order, never cycled: a venue keeps its colour
 *  whatever else is on screen, and the 7th folds into "other" rather than
 *  inventing a hue. */
export const VENUES: { key: Venue; label: string; slot: string }[] = [
  { key: 'reddit',     label: 'Reddit',       slot: 'var(--s-1)' },
  { key: 'hackernews', label: 'Hacker News',  slot: 'var(--s-2)' },
  { key: 'x',          label: 'X',            slot: 'var(--s-3)' },
  { key: 'youtube',    label: 'YouTube',      slot: 'var(--s-10)' },
  { key: 'github',     label: 'GitHub',       slot: 'var(--s-4)' },
  { key: 'gitlab',     label: 'GitLab',       slot: 'var(--s-13)' },
  { key: 'bugzilla',   label: 'Bugzilla',     slot: 'var(--s-14)' },
  { key: 'discord',    label: 'Discord',      slot: 'var(--s-11)' },
  { key: 'linkedin',   label: 'LinkedIn',     slot: 'var(--s-12)' },
  { key: 'telegram',   label: 'Telegram',     slot: 'var(--s-7)' },
  { key: 'signal',     label: 'Signal',       slot: 'var(--s-8)' },
  { key: 'whatsapp',   label: 'WhatsApp',     slot: 'var(--s-9)' },
  { key: 'blog',       label: 'Blogs',        slot: 'var(--s-5)' },
  { key: 'forum',      label: 'Forums',       slot: 'var(--s-6)' },
];

const FALLBACK = { key: 'other' as Venue, label: 'Other', slot: 'var(--ink-3)' };

export const venueOf = (key: Venue) => VENUES.find((v) => v.key === key) ?? { ...FALLBACK, key };

export const fmtScore = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(2);

export const fmtMonth = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', year: '2-digit' });

/** Label a timeline bucket at whatever grain it actually is.
 *
 *  Buckets are no longer always months — a scan covering a fortnight is bucketed
 *  by day, and calling every bar "Sep 26" when there are thirty of them in
 *  September is worse than useless. The bucket's own shape says which it is: a
 *  month bucket is always the first of the month, so anything else is finer.
 *
 *  Not perfect — the 1st of a month is genuinely ambiguous — so callers pass the
 *  series and the decision is made once for all of it. */
export function fmtBucket(iso: string, grain: 'day' | 'week' | 'month'): string {
  const date = new Date(iso);
  if (grain === 'month') return date.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** What grain a series of buckets is at, read from the gaps between them.
 *
 *  Derived rather than passed down from the server: the charts take a list of
 *  points and nothing else, and threading a grain through every caller to say
 *  something the data already shows would be ceremony. */
export function grainOf(buckets: string[]): 'day' | 'week' | 'month' {
  if (buckets.length < 2) return buckets[0]?.endsWith('-01') ? 'month' : 'day';
  const days = (Date.parse(buckets[1]!) - Date.parse(buckets[0]!)) / 86_400_000;
  if (days >= 28) return 'month';
  if (days >= 6) return 'week';
  return 'day';
}

export const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'undated';

export function counts(mentions: Mention[]) {
  const map = new Map<Venue, number>();
  for (const m of mentions) {
    const key = venueOf(m.venue).key;
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

/** Turn an API path into one that survives being served behind a proxy.
 *
 *  Two things go wrong otherwise, and both are silent.
 *
 *  A leading slash means "the root of this origin", which throws away whatever
 *  prefix the app is mounted under — `/api/scans` instead of
 *  `/whisperer/api/scans`. So any leading slash is stripped rather than
 *  trusted; a caller writing one is asking for a path, not for the root.
 *
 *  A bare relative path is resolved against the current document, which is
 *  correct only while that document's URL ends in a slash. Mounted at
 *  `/whisperer` with no trailing slash, `api/scans` resolves to `/api/scans`
 *  and loses the prefix in the other direction. So it is joined onto the base
 *  the bundle was built with, which is the one thing that knows where this is
 *  mounted.
 */
export function apiUrl(path: string): string {
  const base = (import.meta.env.BASE_URL || '/').replace(/\/*$/, '/');
  return base + path.replace(/^\/+/, '');
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

/** "3h ago" — how stale the thing on screen is.
 *
 *  A scan is a snapshot of a moving internet, and the panel gives no clue how
 *  old its snapshot is. Without this, discovery run four days ago looks exactly
 *  like discovery run a minute ago. */
export function fmtAgo(iso: string | undefined | null): string | null {
  if (!iso) return null;
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return null;
  // No "ago". Every reading of this is already in a context that says so — a
  // column of ages, a "pulled" label — and the word is then printed once per
  // row to add nothing. The unit carries it: `14h` beside a company name is not
  // ambiguous.
  if (ms < 90_000) return 'just now';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

/** Strip markdown for display.
 *
 *  `cleanText` now does this at ingest, but every scan recorded before that
 *  still holds the markup, and re-running an hour and a half of pipeline to
 *  make old text readable is not a reasonable price. Idempotent, so applying it
 *  to text that was already cleaned costs nothing.
 */
export { stripMarkdown as plain } from '../../shared/markdown.ts';
