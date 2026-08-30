/** The one directory this app is allowed to read code from.
 *
 *  ── Why it is a directory and not a credential ──────────────────────────────
 *
 *  Diagnosing a closed-source product means reading a private repository, and
 *  the obvious designs are all bad. A repo URL plus a private key means this
 *  app holds a key that can clone the company's source, which is a thing worth
 *  stealing and a thing worth refusing to give — and it does not even work,
 *  because a passphrase-protected key cannot be used unattended. A personal
 *  access token is the same problem with a wider blast radius.
 *
 *  So the checkout is not this app's job. Somebody with the right access runs
 *  `git clone <private-repo>` into the workspace themselves, with their own
 *  credentials, their own agent, their own passphrase prompt. Then they type
 *  the directory's name here. This app never holds a credential that can reach
 *  their source, and there is nothing here to steal.
 *
 *  ── Why the name is resolved rather than used ───────────────────────────────
 *
 *  A path typed into a web form and handed to the filesystem is an arbitrary
 *  file read. `../../../etc/shadow` is the obvious one; `/etc` on its own is
 *  the same bug with less typing. This app reads whatever it is pointed at and
 *  feeds it to a model, so an unchecked path is a way to exfiltrate any file
 *  the server can open, and the interesting files are all credentials.
 *
 *  Every path therefore goes through `resolveWorkspace`, which takes a bare
 *  name and returns an absolute path only if it genuinely sits inside the root.
 *  The check is made against the *real* path, after symlinks are resolved: a
 *  symlink planted inside the workspace is otherwise a hole straight through
 *  a check that only looked at the string.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Where checkouts live. Overridable because a real deployment will want this
 *  on a volume with room on it, not inside the app directory. */
export function workspaceRoot(): string {
  const configured = process.env.WHISPERER_WORKSPACE_ROOT;
  const root = configured
    ? path.resolve(configured)
    : path.resolve(import.meta.dirname, '../../data/workspaces');
  mkdirSync(root, { recursive: true });
  return realpathSync(root);
}

export class WorkspaceError extends Error {}

/** True when `target` is the root itself or something underneath it.
 *
 *  The separator matters: a plain `startsWith(root)` also accepts
 *  `/data/workspaces-evil`, which is a different directory that merely shares a
 *  prefix. */
function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/** Turn a name typed by a person into an absolute path inside the workspace,
 *  or refuse.
 *
 *  Refuses, in order: nothing, an absolute path, anything containing a `..`
 *  segment, a name that git would read as a flag, a name that does not exist,
 *  something that is not a directory, anything whose real path escapes the root
 *  (which is the symlink case), and a directory that is not a git checkout. */
export function resolveWorkspace(name: string): string {
  const raw = (name ?? '').trim();
  if (!raw) throw new WorkspaceError('no workspace given');
  if (path.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw)) {
    throw new WorkspaceError(
      'a workspace is a name inside the workspace directory, not a path on this machine',
    );
  }
  if (raw.split(/[\\/]/).some((segment) => segment === '..')) {
    throw new WorkspaceError('a workspace name cannot climb out with ".."');
  }
  // execFile passes arguments without a shell, so this is not injection — but
  // git would still read `-u` as an option rather than as a directory.
  if (raw.startsWith('-')) throw new WorkspaceError('a workspace name cannot start with "-"');

  const root = workspaceRoot();
  const candidate = path.resolve(root, raw);
  if (!existsSync(candidate)) {
    throw new WorkspaceError(
      `no "${raw}" in the workspace — clone it there first: git clone <repo> ${path.join(root, raw)}`,
    );
  }

  // realpath AFTER existence, because it throws on a missing path and the
  // message above is the useful one. This is the check that matters: every
  // string test above can be satisfied by a symlink that points anywhere.
  const real = realpathSync(candidate);
  if (!inside(root, real)) {
    throw new WorkspaceError(`"${raw}" resolves outside the workspace directory, so it will not be read`);
  }
  if (!statSync(real).isDirectory()) throw new WorkspaceError(`"${raw}" is not a directory`);
  if (!existsSync(path.join(real, '.git'))) {
    throw new WorkspaceError(`"${raw}" is not a git checkout — clone the repository into it`);
  }
  return real;
}

export interface Workspace {
  name: string;
  /** The origin remote, with any embedded credential stripped. */
  remote: string | null;
  branch: string | null;
  /** Last commit date, so a stale checkout is visible as one. */
  updated: string | null;
}

/** A clone URL can carry `https://user:token@host/...`. That token belongs to
 *  whoever ran the clone and must not be handed back to a browser. */
function redact(remote: string): string {
  return remote.replace(/\/\/[^/@]*@/, '//');
}

async function describe(root: string, name: string): Promise<Workspace> {
  const dir = path.join(root, name);
  const git = async (args: string[]) => {
    try {
      const { stdout } = await run('git', ['-C', dir, ...args], { timeout: 10_000 });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  };
  const [remote, branch, updated] = await Promise.all([
    git(['config', '--get', 'remote.origin.url']),
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
    git(['log', '-1', '--format=%cI']),
  ]);
  return { name, remote: remote ? redact(remote) : null, branch, updated };
}

/** Every git checkout sitting in the workspace, so the dashboard can offer a
 *  list to pick from rather than a box to type a path into. Offering the list
 *  is not only friendlier — a name picked from what is actually there cannot be
 *  a probe for somewhere else. */
export async function listWorkspaces(): Promise<Workspace[]> {
  const root = workspaceRoot();
  const names = readdirSync(root, { withFileTypes: true })
    .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()))
    .map((entry) => entry.name)
    .filter((name) => {
      // Only real, contained git checkouts are listed. A symlink out of the
      // workspace is skipped here for the same reason resolveWorkspace refuses
      // it, so it never appears as something that could be picked.
      try {
        const real = realpathSync(path.join(root, name));
        return inside(root, real) && existsSync(path.join(real, '.git'));
      } catch {
        return false;
      }
    })
    .sort();
  return Promise.all(names.map((name) => describe(root, name)));
}
