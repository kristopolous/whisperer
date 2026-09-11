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
import { loadConfig, loadRaw, writeRaw } from './config.ts';
import { resolveWorkspace } from './workspace.ts';

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
  /** Set when somebody has established there is no source to read.
   *
   *  A real answer, and one that has to be storable. Most products people
   *  complain about are closed, and without this the resolve step's guess keeps
   *  coming back: bolt.new resolves to `stackblitz/bolt.new`, which exists, is
   *  public, and is not the product — so every visit offers to read a codebase
   *  that cannot contain the defect. Recording "no" stops the offer and stops
   *  it being re-guessed. */
  noSource?: boolean;
}

/** What is known about a company's project, and where each part came from.
 *
 *  Two sources, kept apart on purpose. Discovery is a guess made by a model
 *  from a name and a website — usually right, sometimes confidently wrong, and
 *  never something to silently prefer over a person's answer. What somebody
 *  typed in is a statement. So both are carried, the typed one wins, and the
 *  screen can show what would have been used if it were removed.
 *
 *  Per company rather than per scan: rescanning a company must not lose the
 *  fact that its tracker is a Bugzilla on a different host. That is a durable
 *  fact about the project, not about one run of it. */
export interface Project {
  company: string;
  /** What a person specified, if anything. */
  specified: Omit<RepoConfig, 'company'>;
  /** What the resolve agent worked out, for the fields it can answer. */
  discovered: { url?: string; tracker?: string };
  /** What will actually be used, field by field. */
  effective: { url?: string; tracker?: string; path?: string; testCommand?: string };
  /** Whether there is code to read, where it is, and how sure we are.
   *
   *  The thing the defect screen has to know before offering to read the
   *  source. `discovered` is the case that matters: the resolve step found a
   *  repository with the right name, which for a closed product is routinely
   *  something adjacent — an SDK, an open-source predecessor, a community
   *  client — and reading it produces a confident diagnosis of the wrong
   *  codebase. */
  code: {
    state: 'workspace' | 'specified' | 'discovered' | 'declared-none' | 'unknown';
    /** The checkout directory or repository URL, when there is one. */
    at?: string;
    /** Said in the interface, so nobody has to infer it from a badge. */
    why: string;
  };
  /** Where each effective value came from.
   *
   *  Three origins, not two, and the third is the one that was being
   *  misreported. `specified` is a person's answer and `discovered` is the
   *  resolve agent's, but the tracker has a fourth possibility: nothing
   *  discovers a tracker, ever, and the effective value is the repository URL
   *  on the reasoning that a GitHub or GitLab repo is its own issue tracker.
   *  That is a default. Labelling it "discovered" credited a guess nobody made,
   *  and the note that would have explained it never rendered because the
   *  discovered field was empty. */
  source: Record<'url' | 'tracker' | 'path' | 'testCommand', 'specified' | 'discovered' | 'default' | 'none'>;
}

export function projectFor(company: string, discovered: { repo?: string } = {}): Project {
  const { company: _named, ...specified } = repoFor(company) ?? { company };
  void _named;

  // A repository host is its own issue tracker unless told otherwise, which is
  // true for GitHub and GitLab and false for anything using a separate
  // Bugzilla — hence the override.
  const url = specified.url || discovered.repo || undefined;
  const tracker = specified.tracker || url;

  const origin = (
    typed: string | undefined,
    found: string | undefined,
    fallback: string | undefined,
  ): 'specified' | 'discovered' | 'default' | 'none' => {
    if (typed) return 'specified';
    if (found) return 'discovered';
    return fallback ? 'default' : 'none';
  };

  const code = ((): Project['code'] => {
    if (specified.path) {
      return { state: 'workspace', at: specified.path, why: 'a checkout you pointed at' };
    }
    if (specified.noSource) {
      return { state: 'declared-none', why: 'you recorded that this product has no source to read' };
    }
    if (specified.url) {
      return { state: 'specified', at: specified.url, why: 'the repository you set' };
    }
    if (discovered.repo) {
      return {
        state: 'discovered',
        at: discovered.repo,
        why: 'found by name, and not confirmed — check it is this product and not something adjacent',
      };
    }
    return { state: 'unknown', why: 'no repository was found and none was set' };
  })();

  return {
    company,
    specified,
    code,
    discovered: { url: discovered.repo || undefined, tracker: undefined },
    effective: {
      url,
      tracker,
      path: specified.path,
      testCommand: specified.testCommand,
    },
    source: {
      url: origin(specified.url, discovered.repo, undefined),
      // The only field with a real default, and the reason this map exists.
      tracker: origin(specified.tracker, undefined, tracker),
      path: origin(specified.path, undefined, undefined),
      testCommand: origin(specified.testCommand, undefined, undefined),
    },
  };
}

/** The repository to act on for this company: what a person set, else what the
 *  scan worked out.
 *
 *  Exported because the callers that fork, and that offer to fork, were reading
 *  `scan.subject.repo` — the resolver's guess — directly. So answering "no, it is
 *  this instead" in the Source code panel changed what got cloned and not what
 *  got forked: the working copy was right and the pull request went to a fork of
 *  the wrong project. One precedence, in one place.
 */
export const codeUrlFor = (company: string, discovered?: string): string | undefined =>
  projectFor(company, { repo: discovered }).effective.url;

/** Write a company's project settings. An empty string clears a field back to
 *  whatever discovery says, which is why they are stored as absent rather than
 *  as empty strings. */
export function patchProject(company: string, changes: Partial<Omit<RepoConfig, 'company'>>): Project {
  const raw = loadRaw<{ repos: RepoConfig[] }>('repos');
  raw.value.repos ??= [];
  const index = raw.value.repos.findIndex(
    (r) => r.company.toLowerCase() === company.trim().toLowerCase(),
  );
  const entry: RepoConfig = index === -1 ? { company: company.trim() } : raw.value.repos[index]!;

  const fields = entry as unknown as Record<string, string | boolean | undefined>;
  for (const [key, value] of Object.entries(changes)) {
    if (key === 'company') continue;
    // Booleans are stored as booleans. Passing `noSource` through the trim
    // below would turn `false` into the string "false", which is truthy — so
    // un-declaring "no source" would have declared it harder.
    if (typeof value === 'boolean') {
      if (value) fields[key] = true;
      else delete fields[key];
      continue;
    }
    const trimmed = String(value ?? '').trim();
    if (trimmed) fields[key] = trimmed;
    else delete fields[key];
  }

  // An entry holding nothing but a company name is noise in the file; drop it
  // so "cleared everything" leaves the config as it was before anyone typed.
  const meaningful = Object.keys(entry).some((k) => k !== 'company');
  if (index === -1) {
    if (meaningful) raw.value.repos.push(entry);
  } else if (!meaningful) {
    raw.value.repos.splice(index, 1);
  }

  writeRaw('repos', raw.value);
  reloadRepos();
  return projectFor(company);
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
  /** A checkout the user put in the workspace themselves, by name.
   *
   *  First, ahead of everything: it is the most explicit statement available of
   *  which code to read, and it is the only option at all for a private
   *  repository this app has no credential for — which is the normal case
   *  inside a company. */
  workspace?: string,
  /** The fork to clone from, as `owner/repo`.
   *
   *  Cloning the fork rather than upstream is what makes the working copy
   *  writable. Everything downstream then has a remote it is allowed to push
   *  to, so a fix is a branch and a push instead of a file-by-file walk of the
   *  Contents API — which cannot express a rename or a deletion and chokes on
   *  anything binary. The guard does not move: the fork is under the token's
   *  own account, and `assertWritable` still checks that before any write. */
  fork?: string,
): Promise<{ path: string; config: RepoConfig }> {
  if (workspace) {
    // Throws with a plain explanation if the name escapes the workspace, is not
    // there, or is not a checkout. Never silently falls through to cloning
    // something else — being pointed at the wrong source is worse than an
    // error, because the diagnosis that comes back looks perfectly credible.
    const resolved = resolveWorkspace(workspace);
    emit('info', `reading the workspace checkout "${workspace}" — nothing is cloned or fetched`);
    return { path: resolved, config: { company, path: resolved } };
  }

  // What a person set, over what the scan worked out — and merged rather than
  // chosen between. An entry that only carries a `testCommand` used to win
  // outright and then fail as "neither a url nor a path", so setting how the
  // tests run could take away the repository.
  const specified = repoFor(company);
  const config = fork
    ? { company, url: `https://github.com/${fork}.git` }
    : specified || discovered
      ? { company, ...(discovered ? { url: discovered } : {}), ...specified }
      : undefined;
  if (!config) {
    throw new Error(
      `no repository configured for "${company}" — add it to config/repos.json before diagnosing`,
    );
  }

  if (config.path) {
    // config/repos.json is an operator file on the server's own disk, so an
    // absolute path here is a deliberate act by someone who already has that
    // access. Anything arriving from the dashboard goes through the workspace
    // resolver above instead, and must not be routed here.
    const resolved = path.resolve(config.path);
    if (!existsSync(resolved)) throw new Error(`configured checkout does not exist: ${resolved}`);
    return { path: resolved, config };
  }

  if (!config.url) throw new Error(`repository for "${company}" has neither a url nor a path`);

  // A fork gets its own directory. The upstream clone is read-only by
  // convention and the fork's is written to, and one directory serving both
  // would mean a stray branch on a checkout something else assumed was clean.
  const slug = (fork ?? config.company).toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  const dir = path.join(ROOT, fork ? `fork-${slug}` : slug);
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
