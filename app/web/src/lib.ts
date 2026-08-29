import type { Mention, Venue } from '../../shared/types.ts';

/** Venue → categorical slot. Fixed order, never cycled: a venue keeps its colour
 *  whatever else is on screen, and the 7th folds into "other" rather than
 *  inventing a hue. */
export const VENUES: { key: Venue; label: string; slot: string }[] = [
  { key: 'reddit',     label: 'Reddit',       slot: 'var(--s-1)' },
  { key: 'hackernews', label: 'Hacker News',  slot: 'var(--s-2)' },
  { key: 'x',          label: 'X',            slot: 'var(--s-3)' },
  { key: 'github',     label: 'GitHub',       slot: 'var(--s-4)' },
  { key: 'blog',       label: 'Blogs',        slot: 'var(--s-5)' },
  { key: 'forum',      label: 'Forums',       slot: 'var(--s-6)' },
];

const FALLBACK = { key: 'other' as Venue, label: 'Other', slot: 'var(--ink-3)' };

export const venueOf = (key: Venue) => VENUES.find((v) => v.key === key) ?? { ...FALLBACK, key };

export const fmtScore = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(2);

export const fmtMonth = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', year: '2-digit' });

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

const TLD = /\.(com|co\.uk|co|org|net|io|dev|app|ai|me|us|gov|edu|xyz|site|news|blog|company|social)$/i;
/** Two-part country TLDs that are not the brand: example.co.uk → example. */
const SECOND_LEVEL = /\.(co\.uk|com\.au|co\.nz|co\.in|com\.br|co\.jp|com\.mx|org\.uk|gov\.uk)$/i;

/** Strip protocol + www + trailing slash so a raw URL reads as a bare host,
 *  e.g. https://www.example.co.uk/ → example.co.uk. */
export function hostOf(raw: string): string {
  return raw
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split(/[/?#]/)[0]
    .trim();
}

/** Derive a clean human title from whatever was typed in, so the subject is
 *  never just a URL. "https://www.example.co.uk/" → "Example". A plain phrase
 *  ("Acme Inc") is passed through unchanged. */
export function cleanName(raw: string): string {
  const value = raw.trim();
  // A plain multi-word phrase (or anything without a dot) is already a name.
  if (!/^https?:\/\//i.test(value) && !/^[\w-]+(\.[\w-]+)+(\.|\/|$)/.test(value)) return value;

  const host = hostOf(value);
  let cleaned = host;
  if (SECOND_LEVEL.test(host)) cleaned = host.replace(SECOND_LEVEL, '');
  else if (TLD.test(host)) cleaned = host.replace(TLD, '');
  else cleaned = host.split('.')[0];

  return cleaned
    .split(/[-_]/)
    .map((part) => part ? part[0].toUpperCase() + part.slice(1) : part)
    .join(' ');
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}
