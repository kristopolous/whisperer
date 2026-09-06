/** File and maintain a GitHub issue as the audit record for one complaint.
 *
 *  The ticket is not a hand-off — it is the ledger. It opens with the public
 *  complaint in the reporters' own words, and every subsequent step in the loop
 *  is appended to it as a comment: the reporter was contacted, this is what was
 *  said to them, the fix landed, the reporter came back and confirmed. Read top
 *  to bottom, one issue is the entire history of one complaint, including
 *  whether the person who raised it was ever actually spoken to.
 *
 *  That last part is the reason to do it this way. "Did anyone tell the user?"
 *  is the question that quietly goes unanswered in every bug tracker, and it is
 *  unanswerable after the fact unless the answer is written down as it happens.
 *
 *  Only the plain REST API is used — issues.create and issues.comment — so this
 *  works against github.com and Enterprise alike with one fine-grained token.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Issue, LoopEvent, Scan } from '../../shared/types.ts';
import { assertWritable } from './fork.ts';
import { channelsConfig } from './index.ts';

const ACCEPT = 'application/vnd.github+json';
const run = promisify(execFile);

export class GithubNotConfigured extends Error {}

/** Where writes for this scan go.
 *
 *  A scan that has been forked writes to its fork, and that beats the
 *  configured repository rather than merely defaulting to it. The fork exists
 *  precisely because the subject's own tracker is off limits, so once one has
 *  been made, a stale `ticketing.github` pointing at somebody else's project
 *  must not be able to win. (`assertWritable` would refuse such a write anyway
 *  — but refusing after the fork was made is a bug report, not a design.)
 *
 *  With no scan, or a scan that has not been forked, this is the configured
 *  repository, which is how the settings panel and `githubConfigured` see it. */
function github(scan?: Scan) {
  const { github: config } = channelsConfig().value.ticketing;
  const forked = splitFullName(scan?.fork);
  const owner = forked?.owner ?? config?.owner;
  const repo = forked?.repo ?? config?.repo;
  if (!owner || !repo) {
    throw new GithubNotConfigured(
      'nowhere to file this — fork the project first, or set ticketing.github owner/repo in config/channels.json',
    );
  }
  if (!config?.token) {
    throw new GithubNotConfigured('no GitHub token — set GITHUB_TOKEN (Issues: read and write)');
  }
  return { ...config, owner, repo, apiBase: (config.apiBase ?? 'https://api.github.com').replace(/\/$/, '') };
}

/** "kristopolous/hangman-test" → its two halves. Anything else is not a target. */
function splitFullName(fullName?: string): { owner: string; repo: string } | null {
  const [owner, repo, ...rest] = (fullName ?? '').split('/');
  return owner && repo && rest.length === 0 ? { owner, repo } : null;
}

/** True when a ticket could be filed with no further setup — a token plus
 *  somewhere to put it. A scan makes this specific: a forked scan is filable
 *  even when nothing is configured. */
export function githubConfigured(scan?: Scan): boolean {
  try {
    github(scan);
    return true;
  } catch {
    return false;
  }
}

type Target = ReturnType<typeof github>;

/** Where a write for this scan would go, as `owner/repo`, or null if nowhere.
 *
 *  Exported so that anything reporting on a write can name its destination
 *  rather than a bare issue number. "Filed as #12" is the sentence that lets a
 *  person assume it went to the project; "filed as kristopolous/hangman-test#12"
 *  cannot be misread. */
export function writeTarget(scan?: Scan): string | null {
  try {
    const target = github(scan);
    return `${target.owner}/${target.repo}`;
  } catch {
    return null;
  }
}

async function call<T>(config: Target, path: string, body?: unknown, method?: 'POST' | 'PUT'): Promise<T> {
  const response = await fetch(`${config.apiBase}/repos/${config.owner}/${config.repo}${path}`, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: {
      Accept: ACCEPT,
      Authorization: `Bearer ${config.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    // 403 here is nearly always the token lacking Issues:write on this repo
    // rather than rate limiting, and saying so saves an hour.
    const hint = response.status === 403 || response.status === 404
      ? ' — check the token has Issues: read and write on this exact repo'
      : '';
    throw new Error(`github ${response.status}${hint}: ${detail.slice(0, 200)}`);
  }
  return (await response.json()) as T;
}

export interface FiledIssue {
  number: number;
  url: string;
}

/** Open the issue. The body is whatever the ticket agent drafted, with the
 *  audit header prepended so the ledger starts at the top. */
export async function createIssue(
  scan: Scan, issue: Issue, title: string, body: string, labels: string[],
): Promise<FiledIssue> {
  // Hard stop before anything is written. Filing a bot-written ticket on
  // somebody else's tracker wastes a maintainer's time and cannot be undone by
  // deleting it afterwards — they have already read it.
  const target = github(scan);
  await assertWritable(target.owner, target.repo);

  const created = await call<{ number: number; html_url: string }>(target, '/issues', {
    title,
    body: `${auditHeader(scan, issue)}\n\n---\n\n${body}`,
    labels,
  });
  return { number: created.number, url: created.html_url };
}

export async function commentOnIssue(scan: Scan, number: number, body: string): Promise<string> {
  const target = github(scan);
  await assertWritable(target.owner, target.repo);
  const created = await call<{ html_url: string }>(target, `/issues/${number}/comments`, { body });
  return created.html_url;
}

/** The block at the top of a filed issue: where this came from, who raised it,
 *  and — the part that is usually missing — whether they have been spoken to. */
function auditHeader(scan: Scan, issue: Issue): string {
  const reporter = issue.reporter;
  const contacted = (issue.loop ?? []).some((event) => event.step === 'outreach');
  const confirmed = (issue.loop ?? []).some((event) => event.step === 'confirmed');

  return [
    `> Filed automatically from public discussion of **${scan.company}**.`,
    '>',
    `> **Reported by** ${reporter ? `\`${reporter.handle}\` on ${reporter.venue} — ${reporter.sourceUrl}` : 'multiple people; see the evidence links below'}`,
    reporter ? `> **Contact route** ${reporter.channel} (${reporter.confidence} confidence, established via ${reporter.basis})` : '',
    `> **Reporter contacted** ${contacted ? 'yes' : 'not yet'}`,
    `> **Fix confirmed by reporter** ${confirmed ? 'yes' : 'not yet'}`,
    '>',
    '> Every step of the loop is appended to this issue as a comment. If the last comment does not',
    "> say the reporter confirmed it, nobody has established that this is actually fixed.",
  ].filter(Boolean).join('\n');
}

/** One loop step, rendered as a comment. The verbatim message is included
 *  whenever the step was something said to or by a person — an audit trail that
 *  paraphrases what was sent in the company's name is not an audit trail. */
export function loopComment(event: LoopEvent): string {
  const who = event.actor === 'reporter' ? 'the reporter' : event.actor;
  const lines = [
    `**${event.step}** — ${event.summary}`,
    '',
    `*${new Date(event.at).toISOString()} · by ${who}${event.human ? ' (human action)' : ''}*`,
  ];
  if (event.ref) lines.push('', `Ref: ${event.ref.url ? `[${event.ref.label}](${event.ref.url})` : event.ref.label}`);
  if (event.message) lines.push('', 'Verbatim:', '', '> ' + event.message.replace(/\n+/g, '\n> '));
  return lines.join('\n');
}

/** Append a loop step to the issue this complaint was filed as, if it was filed
 *  to GitHub at all. Never throws into the caller's path: failing to annotate
 *  the ledger must not fail the action that was actually being taken. */
export async function recordLoopStep(scan: Scan, issue: Issue, event: LoopEvent): Promise<string | null> {
  if (issue.filedTo?.tracker !== 'github') return null;
  const number = Number(issue.filedTo.ref.replace(/^#/, ''));
  if (!Number.isFinite(number)) return null;
  try {
    return await commentOnIssue(scan, number, loopComment(event));
  } catch {
    return null;
  }
}

/** Open a pull request on OUR fork, carrying the patched files.
 *
 *  Committed through the API rather than by pushing a git branch: the work copy
 *  the fix ran in is a throwaway clone of the upstream with no credentials and
 *  no remote of ours, and wiring git auth into it would be a second way to
 *  write to a repository — which is exactly the thing being kept to one guarded
 *  path.
 *
 *  Every call goes through `assertWritable` first. A pull request against an
 *  upstream project is the single most costly thing this pipeline could do by
 *  accident: it notifies maintainers, it sits in their queue, and deleting it
 *  afterwards does not unsend it.
 */
export interface OpenedPr {
  number: number;
  url: string;
  branch: string;
}

/** Push a working copy's changes to the fork as a branch, then open the pull
 *  request from it.
 *
 *  The alternative — and what this replaces — was committing file by file
 *  through the Contents API, which the old comment justified by noting that the
 *  work copy was a clone of UPSTREAM with no remote of ours. Now that the copy
 *  is a clone of the fork, that reason is gone, and the API walk's limits are
 *  not worth keeping: it cannot express a deletion or a rename, it re-uploads
 *  whole files for a one-line change, and it needs a round trip per file.
 *
 *  The token is put on the remote for the length of the push and taken off
 *  again. It is never written to the repository's config, so it cannot leak
 *  into a later `git remote -v` or a stray commit.
 */
export async function pushBranch(
  scan: Scan,
  workdir: string,
  branch: string,
  message: string,
  emit: (level: 'info' | 'warn', text: string) => void,
): Promise<void> {
  const target = github(scan);
  await assertWritable(target.owner, target.repo);
  if (!target.token) throw new GithubNotConfigured('no GitHub token to push with');

  const git = (...args: string[]) => run('git', ['-C', workdir, ...args], { timeout: 300_000 });

  await git('checkout', '-B', branch);
  await git('add', '-A');
  // `-c` rather than global config: the identity is for this commit, not for
  // the machine.
  await git('-c', 'user.name=whisperer', '-c', 'user.email=whisperer@localhost',
    'commit', '-m', message, '--allow-empty');

  const authed = `https://x-access-token:${target.token}@github.com/${target.owner}/${target.repo}.git`;
  try {
    await run('git', ['-C', workdir, 'push', '--force', authed, `HEAD:refs/heads/${branch}`], {
      timeout: 300_000,
    });
  } catch (error) {
    // Never let the token reach a log line or an error the dashboard renders.
    const why = error instanceof Error ? error.message.replaceAll(target.token, '***') : 'push failed';
    throw new Error(`could not push to ${target.owner}/${target.repo}: ${why.slice(0, 200)}`);
  }
  emit('info', `pushed ${branch} to ${target.owner}/${target.repo}`);
}

/** Open a pull request from a branch that is already on the fork.
 *
 *  Separate from pushing it. The branch gets there by `git push` now — see
 *  pushBranch — so this is only the API call that turns it into a pull request,
 *  and it is idempotent: a second run on the same branch finds the open one
 *  rather than failing on a duplicate. */
export async function createPullRequest(
  scan: Scan,
  branch: string,
  title: string,
  body: string,
  emit: (level: 'info' | 'warn', text: string) => void,
): Promise<OpenedPr> {
  const target = github(scan);
  await assertWritable(target.owner, target.repo);

  const repo = await call<{ default_branch: string }>(target, '');
  const base = repo.default_branch;

  const open = await call<{ number: number; html_url: string }[]>(
    target, `/pulls?head=${target.owner}:${branch}&state=open`,
  );
  if (open.length) {
    emit('info', `pull request #${open[0]!.number} already open for ${branch}`);
    return { number: open[0]!.number, url: open[0]!.html_url, branch };
  }

  // Against the FORK's own default branch, never the upstream's. A pull
  // request that notified the real maintainers is the one thing this whole
  // arrangement exists to prevent.
  const pr = await call<{ number: number; html_url: string }>(target, '/pulls', {
    title, body, head: branch, base,
  });
  emit('info', `pull request #${pr.number} opened on ${target.owner}/${target.repo}`);
  return { number: pr.number, url: pr.html_url, branch };
}

export async function openPullRequest(
  scan: Scan,
  files: { path: string; contents: string }[],
  title: string,
  body: string,
  emit: (level: 'info' | 'warn', text: string) => void,
): Promise<OpenedPr> {
  const target = github(scan);
  await assertWritable(target.owner, target.repo);
  if (files.length === 0) throw new Error('nothing to open a pull request with');

  const repo = await call<{ default_branch: string }>(target, '');
  const base = repo.default_branch;
  const branch = `whisperer/fix-${Date.now().toString(36)}`;

  const head = await call<{ object: { sha: string } }>(target, `/git/ref/heads/${base}`);
  await call(target, `/git/refs`, { ref: `refs/heads/${branch}`, sha: head.object.sha });
  emit('info', `branch ${branch} created on ${target.owner}/${target.repo}`);

  for (const file of files) {
    // An existing file needs its blob sha to be replaced; a new one must not
    // carry a sha at all.
    let sha: string | undefined;
    try {
      const existing = await call<{ sha: string }>(target, `/contents/${encodeURI(file.path)}?ref=${branch}`);
      sha = existing.sha;
    } catch {
      sha = undefined;
    }

    await call(target, `/contents/${encodeURI(file.path)}`, {
      message: `${sha ? 'Update' : 'Add'} ${file.path}`,
      content: Buffer.from(file.contents, 'utf8').toString('base64'),
      branch,
      ...(sha ? { sha } : {}),
    }, 'PUT');
    emit('info', `committed ${file.path}`);
  }

  const pr = await call<{ number: number; html_url: string }>(target, '/pulls', {
    title,
    body,
    head: branch,
    // Against our own fork's default branch — never the upstream.
    base,
  });

  emit('info', `pull request #${pr.number} opened on the fork`);
  return { number: pr.number, url: pr.html_url, branch };
}
