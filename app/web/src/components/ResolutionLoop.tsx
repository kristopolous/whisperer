import type { Issue, LoopEvent, LoopStep } from '../../../shared/types.ts';
import { fmtDate, venueOf } from '../lib.ts';

/** The audit trail: a public complaint followed all the way to the reporter
 *  agreeing it is fixed.
 *
 *  What this view is really for is letting someone check the claim rather than
 *  take it on trust. So it shows every step, names who took it, and quotes the
 *  outgoing messages in full — a reply posted in the company's name is exactly
 *  the thing a reader needs to be able to reread and judge.
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

export function ResolutionLoop({ issue }: { issue: Issue }) {
  const loop = issue.loop ?? [];
  if (loop.length === 0) return null;

  const humanSteps = loop.filter((event) => event.human);
  const closed = loop.some((event) => event.step === 'closed');
  const awaiting = !closed && loop.some((event) => event.step === 'fix-notified');

  return (
    <>
      <h5>Resolution loop</h5>

      <div className={`loop-status ${closed ? 'closed' : 'open'}`}>
        <div className="loop-status-h">
          {closed
            ? 'Closed — confirmed by the person who reported it'
            : awaiting
              ? 'Waiting on the reporter to confirm'
              : 'In progress'}
        </div>
        <div className="loop-status-b">
          {loop.length} steps · {humanSteps.length} human {humanSteps.length === 1 ? 'action' : 'actions'}
          {humanSteps.length > 0 && humanSteps.every((event) => event.actor === 'reporter')
            ? ', all the reporter’s'
            : ', some taken by staff'}
          {awaiting && ' · the fix shipped, but nothing closes this except their reply'}
        </div>
      </div>

      {issue.reporter && (
        <div className="loop-reporter">
          <div className="loop-reporter-h">
            <a href={issue.reporter.sourceUrl} target="_blank" rel="noreferrer">
              {issue.reporter.handle}
            </a>
            <span className="tag plain">{venueOf(issue.reporter.venue).label}</span>
            <span className={`tag ${issue.reporter.confidence === 'high' ? 'good' : 'warning'}`}>
              {issue.reporter.confidence} confidence
            </span>
          </div>
          {/* How the contact route was established, recorded so the trail shows
              it was found rather than guessed — contacting the wrong person in
              the company's name is worse than contacting nobody. */}
          <div className="q">{issue.reporter.basis}</div>
        </div>
      )}

      <ol className="loop">
        {loop.map((event) => (
          <Step key={event.id} event={event} />
        ))}
      </ol>
    </>
  );
}

function Step({ event }: { event: LoopEvent }) {
  const quoted = CONVERSATIONAL.includes(event.step) && event.message;

  return (
    <li className={`loop-step actor-${event.actor}`}>
      <div className="loop-mark" aria-hidden />
      <div className="loop-body">
        <div className="loop-head">
          <span className="loop-label">{STEP_LABEL[event.step]}</span>
          <span className={`tag ${event.actor === 'reporter' ? 'good' : 'plain'}`}>
            {event.actor === 'reporter' ? 'reporter · human' : event.actor}
          </span>
          <span className="loop-at">{fmtDate(event.at)}</span>
        </div>

        <div className="loop-summary">{event.summary}</div>

        {quoted && <blockquote className="loop-message">{event.message}</blockquote>}

        {event.ref && (
          <div className="loop-ref">
            {event.ref.url
              ? <a href={event.ref.url} target="_blank" rel="noreferrer">{event.ref.label}</a>
              : <span>{event.ref.label}</span>}
          </div>
        )}
      </div>
    </li>
  );
}
