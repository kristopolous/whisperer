/** Never write to somebody else's repository.
 *
 *  Testing this pipeline means filing tickets and opening pull requests from a
 *  model's output. Doing that on a real project would be a genuine harm: an
 *  unreviewed bot ticket on GIMP's tracker wastes a maintainer's afternoon, and
 *  a bot pull request is worse. Open-source maintainers are already drowning in
 *  this, and "we were testing" is not a defence.
 *
 *  So everything writes to a fork under the authenticated account, and the
 *  guard below is a hard stop rather than a convention: any write to a
 *  repository the token's own user does not own is refused, whatever the
 *  configuration says. Config can be edited by accident; this cannot.
 */

import { secret } from '../secrets.ts';

const API = 'https://api.github.com';

function headers(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'whisperer',
  };
}

let cachedLogin: string | null = null;

/** Who the token belongs to. Everything writable must be under this account. */
export async function authenticatedUser(): Promise<string> {
  if (cachedLogin) return cachedLogin;
  const token = secret('GITHUB_TOKEN');
  if (!token) throw new Error('no GITHUB_TOKEN — set it in Settings before filing anything');

  const response = await fetch(`${API}/user`, { headers: headers(token), signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`GitHub rejected the token (${response.status})`);
  cachedLogin = ((await response.json()) as { login: string }).login;
  return cachedLogin;
}

/** Refuse to write anywhere but the authenticated user's own repositories.
 *
 *  Called before every issue and every pull request. The point is that no
 *  configuration mistake, resolved-subject surprise or copied URL can end with
 *  a write to an upstream project — the check is on the write path itself, not
 *  on the settings that lead to it. */
export async function assertWritable(owner: string, repo: string): Promise<void> {
  const me = await authenticatedUser();
  if (owner.toLowerCase() !== me.toLowerCase()) {
    throw new Error(
      `refusing to write to ${owner}/${repo}: it is not yours. `
      + `This pipeline only ever writes to a fork under ${me}. `
      + `Fork it first, or point ticketing.github at ${me}/${repo}.`,
    );
  }
}

export interface Fork {
  owner: string;
  repo: string;
  fullName: string;
  url: string;
  /** The repository it was forked from, for the record. */
  upstream: string;
  createdNow: boolean;
}

const parseRepo = (url: string): { owner: string; repo: string } | null => {
  try {
    const path = new URL(url.replace(/\.git$/, '')).pathname.replace(/^\/+|\/+$/g, '');
    const [owner, repo] = path.split('/');
    return owner && repo ? { owner, repo } : null;
  } catch {
    return null;
  }
};

/** A fork of `upstreamUrl` under the authenticated account, creating it if it
 *  is not already there.
 *
 *  GitHub creates forks asynchronously, so a fresh one is not immediately
 *  usable — hence the wait. Returning a name that 404s for the next twenty
 *  seconds would just move the failure somewhere less obvious. */
export async function ensureFork(
  upstreamUrl: string,
  emit: (level: 'info' | 'warn', text: string) => void,
): Promise<Fork> {
  const token = secret('GITHUB_TOKEN');
  if (!token) throw new Error('no GITHUB_TOKEN — set it in Settings before forking');

  const source = parseRepo(upstreamUrl);
  if (!source) throw new Error(`not a GitHub repository URL: ${upstreamUrl}`);

  const me = await authenticatedUser();
  const fullName = `${me}/${source.repo}`;

  // Already ours? Nothing to do — and if the upstream IS ours, that is the
  // repository, not something to fork.
  const existing = await fetch(`${API}/repos/${fullName}`, { headers: headers(token), signal: AbortSignal.timeout(20_000) });
  if (existing.ok) {
    emit('info', `using existing fork ${fullName}`);
    return { owner: me, repo: source.repo, fullName, url: `https://github.com/${fullName}`, upstream: `${source.owner}/${source.repo}`, createdNow: false };
  }

  emit('info', `forking ${source.owner}/${source.repo} to ${fullName}`);
  const created = await fetch(`${API}/repos/${source.owner}/${source.repo}/forks`, {
    method: 'POST',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ default_branch_only: true }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!created.ok) {
    throw new Error(`could not fork ${source.owner}/${source.repo} (${created.status}): ${(await created.text()).slice(0, 160)}`);
  }

  // Forking is asynchronous; poll until it answers.
  for (let attempt = 0; attempt < 15; attempt += 1) {
    await new Promise((r) => setTimeout(r, 2_000));
    const check = await fetch(`${API}/repos/${fullName}`, { headers: headers(token), signal: AbortSignal.timeout(20_000) });
    if (check.ok) {
      emit('info', `fork ready at ${fullName}`);
      return { owner: me, repo: source.repo, fullName, url: `https://github.com/${fullName}`, upstream: `${source.owner}/${source.repo}`, createdNow: true };
    }
  }
  throw new Error(`fork of ${source.owner}/${source.repo} did not become available`);
}
