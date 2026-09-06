/** Hand the defect to Jules and let it open the pull request.
 *
 *  Writing a patch for an unfamiliar repository — reading it, setting up its
 *  environment, running its tests — is the hard, expensive part of this product
 *  and the part several well-funded teams are solving properly. Our own fix
 *  agent works on a small repository and would struggle on a large one. So when
 *  a key for one of these services exists, it does the writing.
 *
 *  What does NOT move is the checking. Whoever produces the patch, the loop
 *  still clones the fork, runs the suite, and requires the new test to FAIL
 *  against the original code before the word "fixed" is used. A vendor saying
 *  it fixed something is a claim; that check is what makes it a fact, and it
 *  costs a git clone and a test command.
 *
 *  Jules rather than the alternatives because it is the only one whose whole
 *  flow is documented: a single `x-goog-api-key` header, an explicit
 *  `AUTO_CREATE_PR` mode, and a structured `outputs[].pullRequest.url` on the
 *  finished session. GitHub's own agent returns an artifact id with no
 *  documented way to turn it into a pull request, and Tembo documents neither a
 *  get-by-id endpoint nor any field carrying the PR — both would mean building
 *  the two most important steps on inference.
 */

import type { Issue } from '../../shared/types.ts';
import { secret } from '../secrets.ts';
import { abortable } from '../run-context.ts';
import { describeError } from '../errors.ts';

const BASE = process.env.JULES_BASE ?? 'https://jules.googleapis.com/v1alpha';

export interface JulesResult {
  sessionId: string;
  /** Where a person can watch it work. */
  sessionUrl: string;
  state: string;
  /** The pull request it opened, once it has. */
  pullRequest?: { url: string; title?: string; description?: string };
}

async function call<T>(path: string, key: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'x-goog-api-key': key,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
    signal: abortable(60_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`jules ${response.status}: ${detail.slice(0, 200)}`);
  }
  return (await response.json()) as T;
}

/** The source name Jules knows this repository by.
 *
 *  Looked up rather than constructed. The name is a single hyphenated segment —
 *  `sources/github-myorg-myrepo` — which is not derivable from `owner/repo`
 *  once either part contains a hyphen, and guessing it wrong is a 404 that
 *  looks like "the repository is not connected". Jules only knows repositories
 *  its GitHub app has been installed on, so a miss here is a real answer: it
 *  has not been given access. */
async function sourceFor(key: string, owner: string, repo: string): Promise<string | null> {
  const body = await call<{
    sources?: { name?: string; githubRepo?: { owner?: string; repo?: string } }[];
  }>('/sources?pageSize=100', key);

  const match = (body.sources ?? []).find((source) =>
    source.githubRepo?.owner?.toLowerCase() === owner.toLowerCase()
    && source.githubRepo?.repo?.toLowerCase() === repo.toLowerCase());
  return match?.name ?? null;
}

/** What to tell it.
 *
 *  The complaint in the reporter's own words, not our summary of it. The whole
 *  corpus exists so that a fix is written against what somebody actually hit,
 *  and paraphrasing it into a ticket-shaped abstract throws that away at the
 *  last step. The diagnosis goes in when we have one — it names the file, which
 *  saves the agent the search we already paid for. */
export function briefFor(issue: Issue): string {
  const lines = [
    issue.title,
    '',
    issue.summary,
    '',
    `What the user hits: ${issue.impact}`,
  ];

  if (issue.diagnosis) {
    lines.push(
      '',
      `A previous read of the source concluded: ${issue.diagnosis.likelyCause}`,
      issue.diagnosis.suspectFiles.length
        ? `Suspect files: ${issue.diagnosis.suspectFiles.map((f) => f.path).join(', ')}`
        : '',
      issue.diagnosis.proposedFix ? `Proposed approach: ${issue.diagnosis.proposedFix}` : '',
    );
  }

  lines.push(
    '',
    'Add a regression test that fails without the fix. The change is not accepted '
    + 'unless the new test fails against the original code.',
  );
  return lines.filter((line) => line !== undefined).join('\n');
}

/** Start a session. Returns as soon as it is queued — this does not wait. */
export async function startFix(
  issue: Issue,
  target: { owner: string; repo: string; branch: string },
  emit: (level: 'info' | 'warn', text: string) => void,
): Promise<JulesResult> {
  const key = secret('JULES_API_KEY');
  if (!key) throw new Error('no JULES_API_KEY — set it in Settings, or the built-in fix agent will run instead');

  const source = await sourceFor(key, target.owner, target.repo);
  if (!source) {
    throw new Error(
      `Jules has no access to ${target.owner}/${target.repo} — install its GitHub app on that `
      + 'repository, then it will appear as a source',
    );
  }

  const started = await call<{ id?: string; name?: string; state?: string; url?: string }>(
    '/sessions', key,
    {
      method: 'POST',
      body: JSON.stringify({
        prompt: briefFor(issue),
        title: issue.title.slice(0, 120),
        sourceContext: { source, githubRepoContext: { startingBranch: target.branch } },
        // Open the pull request without coming back to ask. There is nobody
        // watching a session started from a scan, and a run that stalls waiting
        // for plan approval looks identical to one that failed.
        automationMode: 'AUTO_CREATE_PR',
        requirePlanApproval: false,
      }),
    },
  );

  const id = started.id ?? started.name?.split('/').at(-1) ?? '';
  emit('info', `jules session ${id} queued — ${started.url ?? 'no session url'}`);
  return { sessionId: id, sessionUrl: started.url ?? '', state: started.state ?? 'QUEUED' };
}

/** Ask how a session is getting on. */
export async function checkFix(sessionId: string): Promise<JulesResult> {
  const key = secret('JULES_API_KEY');
  if (!key) throw new Error('no JULES_API_KEY');

  const session = await call<{
    id?: string; name?: string; state?: string; url?: string;
    outputs?: { pullRequest?: { url?: string; title?: string; description?: string } }[];
  }>(`/sessions/${encodeURIComponent(sessionId)}`, key);

  const pr = (session.outputs ?? []).map((o) => o.pullRequest).find((p) => p?.url);
  return {
    sessionId: session.id ?? sessionId,
    sessionUrl: session.url ?? '',
    state: session.state ?? 'UNKNOWN',
    ...(pr?.url ? { pullRequest: { url: pr.url, title: pr.title, description: pr.description } } : {}),
  };
}

/** Terminal states, so a poller knows when to stop.
 *
 *  Listed rather than inferred from "not RUNNING": an unknown state is treated
 *  as still working, which is the safe direction — polling a finished session a
 *  few more times costs nothing, while giving up on a live one loses the fix. */
const SETTLED = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT']);

export const isSettled = (state: string): boolean => SETTLED.has(state.toUpperCase());

/** Start a fix and wait for it, within a budget.
 *
 *  Bounded because this runs inside a request somebody may be watching. Running
 *  out of budget is not a failure — the session carries on at Jules and the
 *  pull request will appear — so the result says which of those happened. */
export async function fixViaJules(
  issue: Issue,
  target: { owner: string; repo: string; branch: string },
  emit: (level: 'info' | 'warn', text: string) => void,
  options: { waitMs?: number; pollMs?: number } = {},
): Promise<JulesResult> {
  const waitMs = options.waitMs ?? 15 * 60_000;
  const pollMs = options.pollMs ?? 15_000;

  const started = await startFix(issue, target, emit);
  const deadline = Date.now() + waitMs;
  let last = started;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    try {
      last = await checkFix(started.sessionId);
    } catch (error) {
      // A failed poll is not a failed session. Say so and keep asking.
      emit('warn', `could not read the jules session — ${describeError(error).slice(0, 120)}`);
      continue;
    }
    if (last.pullRequest) {
      emit('info', `jules opened ${last.pullRequest.url}`);
      return last;
    }
    if (isSettled(last.state)) {
      emit('warn', `jules finished as ${last.state} without opening a pull request`);
      return last;
    }
  }

  emit('warn', `jules is still working after ${Math.round(waitMs / 60_000)} minutes — ${started.sessionUrl}`);
  return last;
}
