import type { ReactNode } from 'react';
import type { Issue, LoopEvent, LoopStep } from '../../../shared/types.ts';
import { fmtDate } from '../lib.ts';

/** The audit trail: a public complaint followed all the way to the reporter
 *  agreeing it is fixed.
 *
 *  What this view is really for is letting someone check the claim rather than
 *  take it on trust. So it shows every step, names who took it, and quotes the
 *  outgoing messages in full — a reply posted in the company's name is exactly
 *  the thing a reader needs to be able to reread and judge.
 *
 *  It shows the steps that have NOT happened too, and that is the change that
 *  matters. This is reputation management: a complaint sitting unacknowledged
 *  for nine days is the story, and a timeline that renders only completed steps
 *  cannot tell it — an untouched defect drew a blank panel, which reads as
 *  nothing to do rather than as nothing done. The whole ladder is always drawn,
 *  each rung either done with a date and a link, or outstanding with the action
 *  that would advance it.
 *
 *  Two things are deliberately prominent:
 *
 *    - the human count, because the promise is that the only person spending
 *      time on this is the one who already cared enough to complain. If a step
 *      other than theirs were marked human, the promise would be false and the
 *      tally is where you would see it.
 *    - whether the loop actually closed. An issue where the reporter never
 *      answered stays visibly open. Nothing but their confirmation closes it,
 *      so an unanswered follow-up reads as unfinished rather than quietly
 *      counting as a win.
 */

const STEP_LABEL: Record<LoopStep, string> = {
  discovered: 'Reported in public',
  diagnosed: 'Located in the code',
  reproduced: 'Reproduced by a failing test',
  filed: 'Filed in tracker',
  'contact-found': 'Contact route established',
  outreach: 'Reached out',
  fixed: 'Fix shipped',
  'test-added': 'Regression test added',
  'fix-notified': 'Reporter asked to confirm',
  confirmed: 'Reporter confirmed',
  closed: 'Closed',
};

/** Steps that are a message to or from a person, rather than internal work.
 *  These get the quoted treatment. */
const CONVERSATIONAL: LoopStep[] = ['discovered', 'outreach', 'fix-notified', 'confirmed'];

export type LoopAction = 'investigate' | 'diagnose' | 'reproduce' | 'file' | 'reply' | 'notify';

/** The order this is supposed to happen in.
 *
 *  Written down rather than inferred from whatever events exist, because the
 *  point is to show the gap. `needs` is what has to be true first: replying
 *  before anything is filed produces an acknowledgement promising a ticket that
 *  does not exist, and the link the reply is supposed to hand over would be
 *  silently missing from it.
 */
const LADDER: {
  step: LoopStep;
  /** What it means when it has not happened, in the reader's terms. */
  pending: string;
  action?: LoopAction;
  actionLabel?: string;
  /** What pressing this rung's button actually does, shown only when it is the
   *  next move. Per rung, because the sentence differs per rung — passing one
   *  in from outside put a description of reading the source under whichever
   *  step happened to be next. */
  blurb?: string;
  needs?: LoopStep;
  /** True when the rung cannot be attempted without a falsifiable test. */
  needsCheck?: boolean;
  /** Steps only the reporter can take — no button, ever. */
  theirs?: boolean;
}[] = [
  { step: 'discovered', pending: 'Not yet seen in public discussion' },
  {
    step: 'diagnosed',
    pending: 'Nobody has checked this against the source yet',
    action: 'investigate',
    actionLabel: 'Read the source and patch it',
    // Gated. Cloning a repository, reading it against a complaint and running a
    // test suite is minutes of work and real money, and none of it can conclude
    // anything if the issue has no statement that could turn out to be false.
    // "Runs like ass" is exactly the rabbit hole this stops.
    needsCheck: true,
    blurb: 'Reads the project\u2019s source, writes a patch and runs the test suite in a throwaway '
      + 'copy. Nothing is committed or pushed, and a fix only counts as working if the new '
      + 'regression test fails against the original code.',
  },
  {
    // A test that fails against the unpatched code — the thing the word means.
    // It has its own action now. It used to be produced only as a by-product of
    // the patch run, so a defect that had been read and understood sat here with
    // nothing to press, and filing — which is gated on this rung — was blocked
    // behind writing a fix.
    step: 'reproduced',
    pending: 'No test yet that fails against the current code',
    action: 'reproduce',
    actionLabel: 'Write the failing test',
    needs: 'diagnosed',
    theirs: false,
    blurb: 'Writes a test that asserts the reported behaviour and runs it in a throwaway copy, '
      + 'where it has to fail. The run may add test files and nothing else, so it cannot touch the '
      + 'code it is failing against — and a test that passes, or never runs, is thrown away rather '
      + 'than recorded.',
  },
  {
    step: 'filed',
    pending: 'Not filed anywhere — there is nothing to point the reporter at',
    action: 'file',
    actionLabel: 'File it',
    // Filing needs a demonstrated bug, not a report of one.
    //
    // A ticket saying "somebody on Reddit said this is broken" is a rumour with
    // a severity attached; a ticket carrying a test that fails on the current
    // code is a bug. The whole point of reading the source first is to be able
    // to hand over the second kind, and without this gate the ladder let the
    // first kind straight through.
    needs: 'reproduced',
  },
  {
    step: 'outreach',
    pending: 'The person who reported it has not been told it is real',
    action: 'reply',
    actionLabel: 'Draft the reply',
    needs: 'filed',
  },
  { step: 'fixed', pending: 'No fix has landed', action: 'investigate', actionLabel: 'Try to fix it' },
  {
    step: 'fix-notified',
    pending: 'They have not been told it is fixed',
    action: 'notify',
    actionLabel: 'Tell them it is fixed',
    needs: 'fixed',
  },
  { step: 'confirmed', pending: 'Waiting on them to say whether it worked', theirs: true },
];

const DAY = 24 * 60 * 60 * 1000;

/** How long since something happened, in the blunt terms this needs.
 *  Reputation is measured in days of silence, not in relative prose.
 *
 *  Keeps "ago" where it is read as a sentence — "Reported 9 days ago. Last move
 *  6 days ago." — and drops it in the per-step column, where it would be the
 *  same word seven times down the page. */
function since(iso: string, prose = false): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / DAY);
  if (days <= 0) return 'today';
  return `${days} ${days === 1 ? 'day' : 'days'}${prose ? ' ago' : ''}`;
}

export function ResolutionLoop({ issue, onAction, busy, progress }: {
  issue: Issue;
  /** Absent in read-only contexts; a rung then shows its state without a button. */
  onAction?: (action: LoopAction) => void;
  busy?: boolean;
  /** What the running action is doing, drawn under the rung that started it.
   *
   *  Work belongs where it was asked for. This used to live in a separate block
   *  above the ladder, which meant two places on the same screen claimed to be
   *  the next step — one of them a large blue panel that was really just a
   *  duplicate of whichever rung was next. */
  progress?: ReactNode;
}) {
  const loop = issue.loop ?? [];
  const done = new Map<LoopStep, LoopEvent>();
  for (const event of loop) if (!done.has(event.step)) done.set(event.step, event);

  // A `reproduced` event only counts if a test actually backs it.
  //
  // Records written before this distinction existed used `reproduced` for
  // having read the source, so replaying them now claims a demonstration that
  // never happened — and worse, opens the gate in front of filing. The proof
  // lives on `issue.fix`, so it can be checked rather than trusted: no failing
  // test against the original code, no reproduction.
  //
  // Either half of the pipeline can establish it: a reproduction run, which
  // writes a test before any patch exists and may not touch the source, or the
  // fix run's own check that its regression test fails against the original.
  // The first is the better evidence and the one the dedicated rung produces.
  const provenBug = Boolean(
    issue.reproduction?.demonstrated
    || (issue.fix?.provesTheBug?.checked && issue.fix.provesTheBug.failedOnOriginal),
  );
  if (done.has('reproduced') && !provenBug) {
    const stale = done.get('reproduced')!;
    done.delete('reproduced');
    // Not discarded — it was a real step somebody took, and it is what the
    // `diagnosed` rung means. Kept there if nothing better already fills it.
    if (!done.has('diagnosed')) done.set('diagnosed', { ...stale, step: 'diagnosed' });
  }

  // `discovered` is true by construction and nothing ever writes it.
  //
  // An issue exists because people complained about it in public — that IS the
  // first rung. Leaving it unmarked made it the "next" step on every untouched
  // defect, which is both false and useless: it has no action, so the ladder
  // offered no next move at all on exactly the defects that most need one.
  if (!done.has('discovered') && issue.evidence.length > 0) {
    done.set('discovered', {
      id: `${issue.id}-discovered`,
      step: 'discovered',
      at: issue.firstSeen ?? issue.lastSeen ?? issue.observedAt ?? new Date().toISOString(),
      actor: 'system',
      human: false,
      summary: `Found in ${issue.evidence.length} public ${issue.evidence.length === 1 ? 'mention' : 'mentions'}`,
    });
  }

  const humanSteps = loop.filter((event) => event.human);
  const closed = loop.some((event) => event.step === 'closed');
  const awaiting = !closed && loop.some((event) => event.step === 'fix-notified');

  // The first rung that has not happened. Only this one offers its action —
  // a column of five buttons is a menu, and what this screen owes the reader
  // is the next move.
  const next = LADDER.find((rung) => !done.has(rung.step) && !rung.theirs);

  // How long this has been going, from the complaint rather than from the scan.
  const opened = issue.firstSeen ?? done.get('discovered')?.at;
  const lastMove = loop.at(-1)?.at;

  return (
    <>
      <h5>Resolution loop</h5>

      <div className={`loop-status ${closed ? 'closed' : 'open'}`}>
        <div className="loop-status-h">
          {closed
            ? 'Closed — confirmed by the person who reported it'
            : awaiting
              ? 'Waiting on the reporter to confirm'
              : next
                ? `Next: ${next.actionLabel ?? STEP_LABEL[next.step].toLowerCase()}`
                : 'In progress'}
        </div>
        <div className="loop-status-m">
          {opened && <>Reported {since(opened, true)}. </>}
          {lastMove
            ? <>Last move {since(lastMove, true)}. </>
            : <>Nothing has been done about it yet. </>}
          {humanSteps.length === 0
            ? 'No human time spent on it.'
            : `${humanSteps.length} step${humanSteps.length === 1 ? '' : 's'} taken by a person.`}
        </div>
      </div>

      <ol className="loop">
        {LADDER.map((rung) => {
          const event = done.get(rung.step);
          // A check that says the evidence was too thin is not a check.
          const testable = Boolean(issue.check) && !/^cannot be derived/i.test(issue.check!);
          const untestable = Boolean(rung.needsCheck) && !testable;
          const blocked = (rung.needs ? !done.has(rung.needs) : false) || untestable;
          const isNext = next?.step === rung.step;

          return (
            <li key={rung.step} className="loop-step" data-state={event ? 'done' : isNext ? 'next' : 'todo'}>
              <span className="loop-dot" />
              <div className="loop-body">
                <div className="loop-head">
                  <span className="loop-label">{STEP_LABEL[rung.step]}</span>
                  {event
                    ? (
                      <span className="conn-meta">
                        {fmtDate(event.at)} · {since(event.at)} · {event.human ? 'by a person' : event.actor}
                      </span>
                    )
                    : <span className="conn-meta">{rung.pending}</span>}
                  {event?.ref?.url && (
                    <a className="conn-meta" href={event.ref.url} target="_blank" rel="noreferrer">
                      {event.ref.label || 'open'}
                    </a>
                  )}
                </div>

                {event && <p className="loop-summary">{event.summary}</p>}

                {/* The message itself, when the step was one. A reply posted in
                    the company's name is the thing a reader most needs to be
                    able to reread. */}
                {event && CONVERSATIONAL.includes(event.step) && event.message && (
                  <blockquote className="loop-quote">{event.message}</blockquote>
                )}

                {!event && isNext && rung.blurb && <p className="loop-note">{rung.blurb}</p>}
                {!event && isNext && progress}
                {!event && isNext && rung.action && onAction && (
                  <div className="actions">
                    <button
                      className="primary"
                      disabled={busy || blocked}
                      onClick={() => onAction(rung.action!)}
                    >
                      {rung.actionLabel}
                    </button>
                    {/* Said rather than left as a dead control. Replying before
                        anything is filed sends an acknowledgement promising a
                        ticket that does not exist. */}
                    {blocked && untestable && (
                      <span className="conn-meta">
                        {issue.check
                          ? 'No falsifiable test could be derived from what people wrote, so there '
                            + 'is nothing here to confirm or to verify a fix against.'
                          : 'This issue predates the reproduction test, so there is nothing to '
                            + 'check a fix against. Re-run triage to give it one.'}
                      </span>
                    )}
                    {blocked && !untestable && rung.needs === 'reproduced' && (
                      <span className="conn-meta">
                        Nothing yet fails against the current code. A ticket saying somebody
                        complained is a report; one carrying a test that fails is a bug. Write the
                        failing test first — it is the rung above this one.
                      </span>
                    )}
                    {blocked && !untestable && rung.needs && rung.needs !== 'reproduced' && (
                      <span className="conn-meta">
                        {STEP_LABEL[rung.needs]} has to happen first — otherwise the reply has
                        nowhere to point them.
                      </span>
                    )}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </>
  );
}
