/** A disk cache for everything we fetch from the network.
 *
 *  Retrieval is the slow, rate-limited, flaky part of a scan, and almost none
 *  of it changes between runs. Brave's free tier is one request per second, so
 *  a scan that issues forty queries spends the better part of a minute just
 *  waiting on its own gate; a Hacker News thread fetched an hour ago has not
 *  meaningfully changed; and re-running a scan to fix a downstream bug should
 *  not cost the whole retrieval budget again.
 *
 *  So every network read is cached on disk, keyed by exactly what was asked
 *  for. Re-running the buzz stage against the same corpus becomes free, which
 *  is what makes iterating on the prompts tolerable.
 *
 *  Design notes:
 *
 *   - One file per entry, not one big index. A scan writes hundreds of entries
 *     and rewriting a single JSON file each time is how you end up with a
 *     truncated cache after a kill -9.
 *   - Failures are not cached. A 429 or a bot-check page is a transient state
 *     of the world, and remembering it for six hours turns a blip into an
 *     outage. `undefined`/`null` from the producer means "don't store this".
 *   - TTL is per call site, because "search results for a query" and "the text
 *     of a Hacker News thread" go stale at completely different rates.
 *   - Entries are read back with their age, so a caller can say where a value
 *     came from rather than silently presenting week-old data as live.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../data/cache');

/** Set CACHE=off to bypass entirely — for confirming a bug is real and not a
 *  stale entry, which is the first question to ask when output looks wrong. */
const ENABLED = process.env.CACHE !== 'off';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

interface Entry<T> {
  storedAt: number;
  key: string;
  value: T;
}

const counters = { hits: 0, misses: 0, writes: 0, bypassed: 0 };

const fileFor = (namespace: string, key: string) =>
  path.join(ROOT, namespace, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`);

function read<T>(namespace: string, key: string, ttlMs: number): { value: T; ageMs: number } | null {
  try {
    const entry = JSON.parse(readFileSync(fileFor(namespace, key), 'utf8')) as Entry<T>;
    const ageMs = Date.now() - entry.storedAt;
    if (ageMs > ttlMs) return null;
    // Hash collisions are vanishingly unlikely but a wrong cache hit is a
    // silent data-corruption bug, so the original key is stored and checked.
    if (entry.key !== key) return null;
    return { value: entry.value, ageMs };
  } catch {
    return null;
  }
}

function write<T>(namespace: string, key: string, value: T): void {
  const file = fileFor(namespace, key);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ storedAt: Date.now(), key, value } satisfies Entry<T>));
  counters.writes += 1;
}

/** Run `produce` unless a fresh entry already answers this key.
 *
 *  A producer that returns undefined or null is treated as a failure and left
 *  uncached, so the next attempt genuinely retries. */
export async function cached<T>(
  namespace: string, key: string, ttlMs: number, produce: () => Promise<T>,
): Promise<T> {
  if (!ENABLED) {
    counters.bypassed += 1;
    return produce();
  }

  const hit = read<T>(namespace, key, ttlMs);
  if (hit) {
    counters.hits += 1;
    return hit.value;
  }

  counters.misses += 1;
  const value = await produce();
  if (value !== undefined && value !== null) write(namespace, key, value);
  return value;
}

/** Like `cached`, but tells the caller whether this came off disk and how old
 *  it is — for the run trace, so a suspiciously fast stage is explainable. */
export async function cachedWithAge<T>(
  namespace: string, key: string, ttlMs: number, produce: () => Promise<T>,
): Promise<{ value: T; ageMs: number | null }> {
  if (!ENABLED) {
    counters.bypassed += 1;
    return { value: await produce(), ageMs: null };
  }
  const hit = read<T>(namespace, key, ttlMs);
  if (hit) {
    counters.hits += 1;
    return { value: hit.value, ageMs: hit.ageMs };
  }
  counters.misses += 1;
  const value = await produce();
  if (value !== undefined && value !== null) write(namespace, key, value);
  return { value, ageMs: null };
}

export const cacheStats = () => ({ ...counters });

/** What is on disk, per namespace — entries and bytes. */
export function cacheSize(): { namespace: string; entries: number; bytes: number }[] {
  try {
    return readdirSync(ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((dir) => {
        const files = readdirSync(path.join(ROOT, dir.name));
        return {
          namespace: dir.name,
          entries: files.length,
          bytes: files.reduce((sum, f) => sum + statSync(path.join(ROOT, dir.name, f)).size, 0),
        };
      })
      .sort((a, b) => b.bytes - a.bytes);
  } catch {
    return [];
  }
}

/** Drop one namespace, or everything. The corrective path for "this result
 *  looks stale" that does not involve deleting the whole data directory. */
export function clearCache(namespace?: string): void {
  rmSync(namespace ? path.join(ROOT, namespace) : ROOT, { recursive: true, force: true });
}
