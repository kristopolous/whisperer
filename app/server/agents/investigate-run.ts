/** Fork it, read it, patch it, and write down what happened.
 *
 *  One action, because it is one story. Forking, cloning, diagnosing, patching
 *  and opening a pull request were five separate controls in four places, and
 *  nothing about the screen said they belonged together — you had to know the
 *  order. Somebody looking at a defect wants to say "go and look at this", and
 *  the machine can work out that looking requires somewhere to look from.
 *
 *  Each step reports before it runs, so a run that takes minutes is legible
 *  while it takes them. Any step may fail without taking the rest down: a fork
 *  that cannot be made means no ledger, but the diagnosis still stands.
 */

import { randomUUID } from 'node:crypto';
import { describeError, why } from '../errors.ts';
import type { Issue, Scan } from '../../shared/types.ts';
import { ensureFork } from '../channels/fork.ts';
import { createIssue, commentOnIssue, createPullRequest, loopComment, pushBranch } from '../channels/github.ts';
import { codeUrlFor, ensureCheckout } from '../repos.ts';
import { diagnoseIssue } from './diagnose-run.ts';
import { fixIssue } from './fix-run.ts';
import { reproduceIssue } from './reproduce-run.ts';

export type Step =
  | 'forking' | 'cloning' | 'reading' | 'reproducing' | 'patching' | 'pushing' | 'publishing' | 'done';

export interface Progress {
  step: Step;
  note: string;
}

/** Is this something we can fork? Only GitHub, and only when it is not already
 *  ours — a private repository read from the workspace is nobody's to fork. */
const forkable = (repo: string | undefined, workspace: string | undefined): boolean =>
  Boolean(repo && /(^|\/\/)(www\.)?github\.com\//i.test(repo) && !workspace);

export interface InvestigateResult {
  fork?: string;
  diagnosed: boolean;
  /** A test that fails against the unpatched code now exists. */
  reproduced: boolean;
  patched: boolean;
  ledger?: { ref: string; url: string };
  pr?: { number: number; url: string };
}

export async function investigate(
  scan: Scan,
  issue: Issue,
  emit: (level: 'info' | 'warn', text: string) => void,
  onStep: (progress: Progress) => void,
): Promise<InvestigateResult> {
  const result: InvestigateResult = { diagnosed: false, reproduced: false, patched: false };

  // Which pass this is. Investigating twice used to append a second diagnosis
  // and a second fix with nothing distinguishing them, so a reader of the
  // published record could not tell three passes over one problem from three
  // problems. The history is kept — that is what an audit is — and labelled.
  const pass = (issue.investigations ?? 0) + 1;
  issue.investigations = pass;
  const label = (text: string) => (pass > 1 ? `Pass ${pass} — ${text}` : text);

  // 1. Somewhere of our own to work in.
  //
  //    The repository a person set, if they set one. This read the scan's own
  //    guess, so answering "no, it is this instead" in the Source code panel
  //    changed the checkout and not the fork — and the pull request went to a
  //    fork of whatever the resolver had guessed.
  const upstream = codeUrlFor(scan.company, scan.subject?.repo);
  let fork = scan.fork;
  if (!fork && forkable(upstream, scan.workspace)) {
    onStep({ step: 'forking', note: 'making a copy under your own account' });
    try {
      fork = (await ensureFork(upstream!, emit)).fullName;
      scan.fork = fork;
      result.fork = fork;
    } catch (error) {
      // Not fatal. Without a fork there is nowhere to publish and nowhere to
      // push, but reading the code is still worth doing and is what most of
      // this run is for.
      emit('warn', `could not fork — ${why(error)}`);
    }
  }

  // 2. The working copy. From the fork when there is one, so what comes out of
  //    this is pushable.
  onStep({ step: 'cloning', note: fork ? `checking out ${fork}` : 'checking out the source' });
  const { path: repo } = await ensureCheckout(scan.company, emit, upstream, scan.workspace, fork);

  // 3. Read it.
  onStep({ step: 'reading', note: 'reading the source against the complaint' });
  const diagnosis = { ...(await diagnoseIssue(scan, issue, repo, emit)), at: new Date().toISOString() };
  issue.diagnosis = diagnosis;
  result.diagnosed = true;
  issue.loop = [...(issue.loop ?? []), {
    id: randomUUID().slice(0, 8),
    // Reading is not reproducing. This used to write `reproduced`, which let an
    // issue nobody had demonstrated pass the gate in front of filing.
    step: 'diagnosed',
    actor: 'agent',
    at: diagnosis.at,
    human: false,
    summary: label(`Read the source: ${diagnosis.verdict} (${diagnosis.confidence} confidence). `
      + `${diagnosis.searched.hits} matching lines across ${diagnosis.searched.files.length} files. `
      + diagnosis.likelyCause.slice(0, 200)),
  }];

  // A verdict of `not-a-defect` or `insufficient` is an answer, not a failure,
  // and patching on the strength of one would be guessing.
  if (diagnosis.verdict === 'not-a-defect' || diagnosis.verdict === 'insufficient') {
    emit('info', `stopping after the read: ${diagnosis.verdict} — not enough to patch against`);
  } else {
    // 3a. Demonstrate it, before anything is patched.
    //
    //     The order is the point. A test written alongside the patch that makes
    //     it pass can be shaped, without anybody intending to, into a test of
    //     whatever the patch did; a test written first has to fail against the
    //     code as it stands or it is thrown away. So this runs on its own, is
    //     allowed to add test files and nothing else, and its result is what the
    //     `reproduced` rung rests on.
    //
    //     A failure here does not stop the patch. Plenty of real defects cannot
    //     be reduced to a test from a diagnosis alone, and "we could not
    //     demonstrate it" is a fact worth recording rather than a reason to
    //     abandon the run — the patch is just then worth less, and the ladder
    //     says so by leaving the rung open.
    onStep({ step: 'reproducing', note: 'writing a test that fails against the current code' });
    try {
      const reproduction = {
        ...(await reproduceIssue(scan, issue, diagnosis, repo, emit)),
        at: new Date().toISOString(),
      };
      issue.reproduction = reproduction;
      result.reproduced = reproduction.demonstrated;
      issue.loop = [...(issue.loop ?? []), {
        id: randomUUID().slice(0, 8),
        // Only a demonstrated reproduction may write `reproduced`. A test that
        // passed against the buggy code, or never ran, is recorded as part of
        // reading the source — which is what it was.
        step: reproduction.demonstrated ? 'reproduced' : 'diagnosed',
        actor: 'agent',
        at: reproduction.at,
        human: false,
        summary: label(reproduction.demonstrated
          ? `Wrote a failing test in ${reproduction.attempts} attempt(s): `
            + `${reproduction.files.map((f) => f.path).join(', ')}. ${reproduction.detail}`
          : `Could not demonstrate this with a test after ${reproduction.attempts} attempt(s). `
            + `${reproduction.detail}. ${reproduction.notes.slice(0, 200)}`),
        ref: reproduction.files[0]
          ? { label: reproduction.files[0].path }
          : { label: `${reproduction.attempts} attempt(s)` },
      }];
    } catch (error) {
      // Cannot tell how to run this project's tests, most often. Worth saying
      // plainly, and not worth losing the diagnosis over.
      emit('warn', `could not write a failing test — ${why(error)}`);
    }

    onStep({ step: 'patching', note: 'writing a patch and running the tests' });
    const fix = {
      ...(await fixIssue(scan, issue, diagnosis, repo, emit, { reproduction: issue.reproduction })),
      at: new Date().toISOString(),
    };
    issue.fix = fix;
    result.patched = fix.applied && fix.tests.passed;
    const proven = fix.provesTheBug.checked && fix.provesTheBug.failedOnOriginal;

    // Two separate claims, recorded separately because they can come apart.
    //
    //   the bug is real  = a new test FAILS against the original code
    //   the fix works    = the suite PASSES with the patch applied
    //
    // A patch whose test passes both before and after proves nothing: it is
    // green against a bug that was never demonstrated. Writing `fixed` for that
    // is how a scan reports work it did not do.
    // Only when the reproduction step did not already write this rung. The fix
    // run checking its own test against the original code is the fallback for a
    // defect no test could be written for ahead of the patch, not a second
    // reproduction of one that was.
    if (proven && !result.reproduced) {
      issue.loop = [...(issue.loop ?? []), {
        id: randomUUID().slice(0, 8),
        step: 'reproduced',
        actor: 'agent',
        at: fix.at,
        human: false,
        summary: label(`A new test fails against the original code: ${fix.provesTheBug.detail}`),
      }];
    }

    issue.loop = [...(issue.loop ?? []), {
      id: randomUUID().slice(0, 8),
      step: result.patched && proven ? 'fixed' : 'diagnosed',
      actor: 'agent',
      at: fix.at,
      human: false,
      summary: label(result.patched
        ? `Patched ${fix.files.length} file(s) in ${fix.attempts} attempt(s); \`${fix.tests.command}\` passes. `
          + (proven ? 'The new test fails against the original code, so it catches the bug.'
            : 'The new test passes against the original code too, so it demonstrates nothing — '
              + 'the suite being green here does not mean the reported defect was fixed.')
        : `Tried ${fix.attempts} time(s) without landing a working patch. ${fix.notes.slice(0, 160)}`),
      ref: { label: `${fix.attempts} attempt(s)` },
    }];
  }

  // 4. Put the patch somewhere it can be read.
  //
  //    A patch that only exists in a throwaway working copy is a claim. On a
  //    branch with a diff and a pull request, it is reviewable — which is the
  //    difference between this being a demo and being useful.
  if (fork && result.patched && issue.fix) {
    onStep({ step: 'pushing', note: `pushing the patch to ${fork}` });
    try {
      const branch = `whisperer/${issue.id}`;
      await pushBranch(
        scan, issue.fix.workdir, branch,
        `${issue.title}\n\n${issue.fix.summary}`.slice(0, 900),
        emit,
      );
      const proven = issue.fix.provesTheBug.checked && issue.fix.provesTheBug.failedOnOriginal;
      result.pr = await createPullRequest(scan, branch, issue.title, [
        issue.fix.summary,
        '',
        `**Reported publicly.** ${issue.summary}`,
        `**Impact.** ${issue.impact}`,
        '',
        `Tests: \`${issue.fix.tests.command}\` — ${issue.fix.tests.passed ? 'pass' : 'fail'}`,
        `Regression test against the original code: ${issue.fix.provesTheBug.detail}`,
        proven ? '' : '⚠️ The new test does not fail against the original code, so it does not yet prove the fix.',
        '',
        '_Opened automatically against a fork. The upstream project has not been touched or notified._',
      ].filter(Boolean).join('\n'), emit);

      issue.loop = [...(issue.loop ?? []), {
        id: randomUUID().slice(0, 8),
        step: 'test-added',
        actor: 'agent',
        at: new Date().toISOString(),
        human: false,
        summary: label(`Pushed to \`${branch}\` and opened pull request #${result.pr.number} on the fork.`),
        ref: { label: `#${result.pr.number}`, url: result.pr.url },
      }];
    } catch (error) {
      emit('warn', `could not push the patch — ${why(error)}`);
    }
  }

  // 5. Write it down, once, at the end.
  if (fork) {
    onStep({ step: 'publishing', note: `writing the record to ${fork}` });
    try {
      result.ledger = await publishLedger(scan, issue, emit);
    } catch (error) {
      emit('warn', `could not publish the record — ${why(error)}`);
    }
  }

  onStep({ step: 'done', note: '' });
  return result;
}

/** The investigation, written to the fork's own issue tracker.
 *
 *  Published at the end rather than streamed as it happens. A comment per step
 *  is an API call per step, and a run that dies halfway would leave a
 *  half-written record on a page other people can read — which is worse than no
 *  record, because it looks complete.
 *
 *  Idempotent: an issue that already exists for this defect is appended to
 *  rather than duplicated, so investigating twice reads as two passes over one
 *  problem instead of two problems.
 */
async function publishLedger(
  scan: Scan, issue: Issue, emit: (level: 'info' | 'warn', text: string) => void,
): Promise<{ ref: string; url: string }> {
  const existing = issue.filedTo?.tracker === 'github' ? issue.filedTo.ref : null;

  if (!existing) {
    const filed = await createIssue(
      scan, issue, issue.title,
      [
        issue.summary,
        '',
        `**Impact.** ${issue.impact}`,
        '',
        '_Opened automatically on a fork. The upstream project has not been touched or notified._',
      ].join('\n'),
      ['whisperer', issue.kind, issue.severity],
    );
    issue.status = 'filed';
    issue.filedTo = { tracker: 'github', ref: `#${filed.number}`, at: new Date().toISOString() };
    emit('info', `record opened as ${issue.filedTo.ref}`);
  }

  const number = Number((issue.filedTo?.ref ?? '').replace(/^#/, ''));
  if (!Number.isFinite(number)) throw new Error('no issue number to append the record to');

  // Everything since the last time this was published. `publishedUpTo` is the
  // count of loop events already written, so a second pass appends only what is
  // new instead of repeating the whole history.
  const already = issue.publishedUpTo ?? 0;
  const fresh = (issue.loop ?? []).slice(already);
  for (const event of fresh) {
    await commentOnIssue(scan, number, loopComment(event));
  }
  if (issue.fix?.trail?.length) {
    await commentOnIssue(scan, number, workLogComment(issue));
  }
  issue.publishedUpTo = (issue.loop ?? []).length;

  const url = `https://github.com/${scan.fork}/issues/${number}`;
  emit('info', `record published: ${fresh.length} step(s) appended to ${url}`);
  return { ref: `#${number}`, url };
}

/** The attempt-by-attempt record, as one comment.
 *
 *  The failures are the point. "Fixed in 3 attempts" is a number somebody has
 *  to take on faith; what the first two tried and why they were abandoned is
 *  what makes the patch reviewable. */
function workLogComment(issue: Issue): string {
  const fix = issue.fix!;
  const lines = ['**Work log**', ''];
  if (fix.baseline) lines.push(`Before any change: ${fix.baseline.note}`, '');

  for (const step of fix.trail ?? []) {
    lines.push(`**Attempt ${step.n}** — ${step.outcome}`);
    for (const edit of step.edits) lines.push(`- \`${edit.path}\` — ${edit.why}`);
    if (step.rejected.length) lines.push(`- ${step.rejected.length} edit(s) refused: ${step.rejected[0]}`);
    if (step.modelError) lines.push(`- ${step.modelError}`);
    if (step.testOutput && !step.testsPassed) {
      lines.push('', '```', step.testOutput.slice(-800), '```');
    }
    lines.push('');
  }

  lines.push(`Tests: \`${fix.tests.command}\` — ${fix.tests.passed ? 'pass' : 'fail'}`);
  lines.push(`Regression test against the original code: ${fix.provesTheBug.detail}`);
  return lines.join('\n');
}
