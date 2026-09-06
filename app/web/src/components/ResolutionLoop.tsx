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
  reproduced: 'Reproduced',
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

export type LoopAction = 'investigate' | 'file' | 'reply' | 'notify';

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
  needs?: LoopStep;
  /** Steps only the reporter can take — no button, ever. */
  theirs?: boolean;
}[] = [
  { step: 'discovered', pending: 'Not yet seen in public discussion' },
  {
    step: 'reproduced',
    pending: 'Nobody has checked this against the source yet',
    action: 'investigate',
    actionLabel: 'Read the source',
  },
  {
    step: 'filed',
    pending: 'Not filed anywhere — there is nothing to point the reporter at',
    action: 'file',
    actionLabel: 'File it',
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

export function ResolutionLoop({ issue, onAction, busy }: {
  issue: Issue;
  /** Absent in read-only contexts; a rung then shows its state without a button. */
  onAction?: (action: LoopAction) => void;
  busy?: boolean;
}) {
  const loop = issue.loop ?? [];
  const done = new Map<LoopStep, LoopEvent>();
  for (const event of loop) if (!done.has(event.step)) done.set(event.step, event);

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
          const blocked = rung.needs ? !done.has(rung.needs) : false;
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
                    {blocked && (
                      <span className="conn-meta">
                        {STEP_LABEL[rung.needs!]} has to happen first — otherwise the reply has
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
