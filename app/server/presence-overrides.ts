/** Corrections to a company's footprint, kept per company rather than per run.
 *
 *  Presence is not a readout, it is an input. The channels found there decide
 *  where discovery looks: a subreddit in the footprint becomes a direct query
 *  against that subreddit, a GitHub org becomes an issue search. So a wrong
 *  entry is not a cosmetic blemish on a panel — it sends every later stage
 *  somewhere useless — and a missing one silently costs the best source there
 *  is. Both need fixing by hand.
 *
 *  Two kinds of correction, and the pair is the point:
 *
 *  - **Blocked.** Deleting a wrongly-found channel from one run achieves
 *    nothing, because the next run does the same crawl and finds it again. The
 *    removal has to be remembered, so it is stored as a rule rather than as an
 *    edit to a record.
 *  - **Added.** A Discord invite or a subreddit URL that the crawl will never
 *    reach — because the company does not link it — is exactly the knowledge a
 *    person has and the machine does not.
 *
 *  Keyed on the company, not the scan, because a scheduled run mints a new scan
 *  every morning. Corrections attached to a run would have to be re-entered
 *  daily, which is the same as not having them.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Profile } from '../shared/types.ts';

const FILE = path.resolve(import.meta.dirname, '../../data/presence.json');

interface Overrides {
  /** Canonical URLs that must never appear in the footprint again. */
  blocked: string[];
  /** Channels somebody added by hand. */
  added: Profile[];
}

let byCompany: Record<string, Overrides> = load();

function load(): Record<string, Overrides> {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, Overrides>;
  } catch {
    return {};
  }
}

function flush() {
  try {
    mkdirSync(path.dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(byCompany, null, 2));
  } catch {
    // A correction that cannot be saved is still applied to this run. Losing
    // the file must not fail a scan.
  }
}

/** One canonical form for a channel URL, so a block sticks.
 *
 *  A block matched on the raw string would be defeated by a trailing slash, an
 *  `http://` instead of `https://`, a `www.`, or the tracking parameters a
 *  search result arrives with — and the entry would quietly reappear next run,
 *  which is precisely the failure this file exists to prevent. */
export function canonical(url: string): string {
  try {
    const parsed = new URL(url.trim().startsWith('http') ? url.trim() : `https://${url.trim()}`);
    const host = parsed.host.toLowerCase().replace(/^www\./, '');
    const route = parsed.pathname.replace(/\/+$/, '').toLowerCase();
    return `${host}${route}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

const forCompany = (key: string): Overrides =>
  (byCompany[key] ??= { blocked: [], added: [] });

/** What the platform and handle are, read off the URL.
 *
 *  Deterministic rather than a model call. A pasted link already says what it
 *  is — `reddit.com/r/gimp` is the r/gimp subreddit and nothing else — and
 *  asking a model to tell us that would be slower, occasionally wrong, and
 *  impossible to correct. */
export function profileFromUrl(raw: string): Profile | null {
  const url = raw.trim();
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
  } catch {
    return null;
  }

  const host = parsed.host.toLowerCase().replace(/^www\./, '');
  const segments = parsed.pathname.split('/').filter(Boolean);

  const known: [RegExp, string, (s: string[]) => string][] = [
    [/^reddit\.com$/, 'reddit', (s) => (s[0] === 'r' && s[1] ? `r/${s[1]}` : s.join('/'))],
    [/^(discord\.gg|discord\.com)$/, 'discord', (s) => s.at(-1) ?? 'invite'],
    [/^github\.com$/, 'github', (s) => s.slice(0, 2).join('/') || host],
    [/^(x\.com|twitter\.com)$/, 'x', (s) => (s[0] ? `@${s[0]}` : host)],
    [/^(youtube\.com|youtu\.be)$/, 'youtube', (s) => s.join('/') || host],
    [/^t\.me$/, 'telegram', (s) => s.join('/') || host],
    [/^news\.ycombinator\.com$/, 'hackernews', (s) => parsed.searchParams.get('id') ?? s.join('/')],
    [/^(linkedin\.com)$/, 'linkedin', (s) => s.slice(0, 2).join('/') || host],
    [/^(instagram\.com)$/, 'instagram', (s) => (s[0] ? `@${s[0]}` : host)],
    [/^(facebook\.com)$/, 'facebook', (s) => s.join('/') || host],
    [/^(tiktok\.com)$/, 'tiktok', (s) => s.join('/') || host],
    [/^(stackoverflow\.com|.*\.stackexchange\.com)$/, 'stackoverflow', (s) => s.join('/') || host],
  ];

  for (const [pattern, platform, handle] of known) {
    if (pattern.test(host)) {
      return { platform, handle: handle(segments), url, official: false, confidence: 'high' };
    }
  }
  // Anything else is a forum or a site, named by its host. Still useful: the
  // scrape chain and the venue queries both work from the URL.
  return { platform: host, handle: segments.join('/') || host, url, official: false, confidence: 'high' };
}

/** Apply a company's corrections to a freshly-crawled footprint. */
export function applyOverrides(key: string, found: Profile[]): Profile[] {
  const overrides = byCompany[key];
  if (!overrides) return found;

  const blocked = new Set(overrides.blocked.map(canonical));
  const kept = found.filter((profile) => !blocked.has(canonical(profile.url)));

  // Added channels win a collision with a crawled one — somebody typed this in
  // on purpose, including whether it is official.
  const manual = new Map(overrides.added.map((profile) => [canonical(profile.url), profile]));
  return [
    ...overrides.added,
    ...kept.filter((profile) => !manual.has(canonical(profile.url))),
  ];
}

export const overridesFor = (key: string): Overrides =>
  ({ blocked: [...(byCompany[key]?.blocked ?? [])], added: [...(byCompany[key]?.added ?? [])] });

/** Never find this again. Also removes it from `added`, so blocking something
 *  that was added by hand does what it looks like it does. */
export function block(key: string, url: string): void {
  const overrides = forCompany(key);
  const target = canonical(url);
  if (!overrides.blocked.some((entry) => canonical(entry) === target)) overrides.blocked.push(url);
  overrides.added = overrides.added.filter((profile) => canonical(profile.url) !== target);
  flush();
}

export function unblock(key: string, url: string): void {
  const overrides = forCompany(key);
  const target = canonical(url);
  overrides.blocked = overrides.blocked.filter((entry) => canonical(entry) !== target);
  flush();
}

/** Add a channel by URL. Returns null when the URL is unusable. */
export function add(key: string, url: string, official = true): Profile | null {
  const profile = profileFromUrl(url);
  if (!profile) return null;
  profile.official = official;

  const overrides = forCompany(key);
  const target = canonical(profile.url);
  // Adding something previously blocked is a reversal of that decision, not a
  // contradiction to be refused.
  overrides.blocked = overrides.blocked.filter((entry) => canonical(entry) !== target);
  overrides.added = [
    ...overrides.added.filter((entry) => canonical(entry.url) !== target),
    profile,
  ];
  flush();
  return profile;
}
