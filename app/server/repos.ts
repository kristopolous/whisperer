/** Where a company's source code lives, so an issue can be diagnosed against it.
 *
 *  Reading the internet for complaints is only half the claim; the other half
 *  needs a checkout. Which repository belongs to which company is a fact nobody
 *  can infer reliably — a company has many repos, and the one the complaint is
 *  about is a judgement — so it is configuration, in config/repos.json.
 *
 *  Checkouts are shallow and blobless, kept under data/repos, and cloned on
 *  first use. Nothing here ever writes to a checkout: the fix runner copies it
 *  first. Nothing here pushes.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { loadConfig } from './config.ts';

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '../../data/repos');

export interface RepoConfig {
  /** The company as it is typed into a scan, matched case-insensitively. */
  company: string;
  /** Clone URL. Omit if `path` points at an existing checkout. */
  url?: string;
  /** An existing checkout to use as-is, instead of cloning. */
  path?: string;
  /** How this project runs its tests, when it cannot be detected. */
  testCommand?: string;
  /** The issue tracker, when it is not the repository host — a Bugzilla, or a
   *  GitLab mirror of a GitHub repo. Include the query that selects the right
   *  product: `https://bugs.kde.org/rest/bug?product=krita`. */
  tracker?: string;
}

let cache: ReturnType<typeof loadConfig<{ repos: RepoConfig[] }>> | null = null;

export function repoConfig() {
  cache ??= loadConfig<{ repos: RepoConfig[] }>('repos');
  return cache;
}

export const reloadRepos = () => { cache = null; };

export const repoFor = (company: string): RepoConfig | undefined =>
  repoConfig().value.repos.find((r) => r.company.toLowerCase() === company.trim().toLowerCase());

/** The local checkout for a company, cloning it if this is the first time.
 *
 *  Shallow and blobless: diagnosis reads the current state of the code, so the
 *  history is dead weight — GIMP is 203MB at depth 1 and considerably more with
 *  thirty years of commits. */
export async function ensureCheckout(
  company: string,
  emit: (level: 'info' | 'warn', text: string) => void,
  /** A repository the scan already worked out for itself. Takes precedence
   *  over the config file: if someone pasted a GitHub URL into the box, that
   *  is a better answer than anything a config lookup can offer, and requiring
   *  them to also add it to a JSON file to get a diagnosis would be silly. */
  discovered?: string,
): Promise<{ path: string; config: RepoConfig }> {
  const config = repoFor(company)
    ?? (discovered ? { company, url: discovered } : undefined);
  if (!config) {
    throw new Error(
      `no repository configured for "${company}" — add it to config/repos.json before diagnosing`,
    );
  }

  if (config.path) {
    const resolved = path.resolve(config.path);
    if (!existsSync(resolved)) throw new Error(`configured checkout does not exist: ${resolved}`);
    return { path: resolved, config };
  }

  if (!config.url) throw new Error(`repository for "${company}" has neither a url nor a path`);

  const dir = path.join(ROOT, config.company.toLowerCase().replace(/[^a-z0-9._-]+/g, '-'));
  if (existsSync(path.join(dir, '.git'))) {
    emit('info', `using existing checkout at ${path.relative(process.cwd(), dir)}`);
    return { path: dir, config };
  }

  emit('info', `cloning ${config.url} (shallow) — first time only`);
  await run('git', ['clone', '--filter=blob:none', '--depth', '1', config.url, dir], {
    timeout: 600_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  emit('info', 'clone complete');
  return { path: dir, config };
}
