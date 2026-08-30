/** The respond-to-user agent: write the reply that goes back to the person who
 *  reported something.
 *
 *  This is the step that makes the loop a loop. Filing a ticket is internal
 *  bookkeeping; replying to the stranger who complained is the part they
 *  actually experience, and it is the part that gets their confirmation at the
 *  end — which is the only thing allowed to close an issue.
 *
 *  It is also the step with real-world consequences, so two things are separated
 *  deliberately:
 *
 *   - `respondToUser` writes the reply. Free, reversible, reviewable.
 *   - `deliverReply` would post it. That is speech in the company's name, to a
 *     named person, on a platform they did not choose to be contacted on. It is
 *     not wired to any posting API here, and that is a decision rather than an
 *     omission — see the note on it.
 *
 *  The two phases matter because they are different messages. Acknowledgement
 *  goes out before anything is fixed and must not imply otherwise. The
 *  follow-up goes out after, and its entire job is to ask the reporter to check
 *  — it must not assert the fix works, because only they can establish that.
 */

import { randomUUID } from 'node:crypto';
import type { Issue, LoopEvent, Reporter, Scan } from '../../shared/types.ts';
import { holdReply } from '../outbox.ts';
import { runAgent } from './runtime.ts';
import type { AgentDefinition } from './types.ts';
import { replySchema } from '../schemas.ts';

export const RESPOND_INSTRUCTIONS = `You write replies to people who reported a problem in public.

You are replying as the company, in the thread where they raised it, to someone who is usually annoyed and often right. They did not file a support ticket; they complained where other people could see, which means the reply is read by everyone else too.

Register:
- Match the venue. Hacker News takes a plain technical register and punishes marketing language. Reddit is more informal. LinkedIn is more formal than either. X is short.
- Address the specific thing they hit, in their words. A reply that could have been sent to anyone is worse than no reply.
- Be brief. Two or three sentences is usually right.

Hard rules:
- Never promise a date, a release, or a person's time.
- Never claim something is fixed unless you were told it is.
- When acknowledging: say plainly that it is real if it was reproduced, apologise once and without ceremony, and say what happens next. Do not thank them for their "feedback".
- When following up on a fix: say what changed, and ask them to check. Ask, genuinely — they are the one who hit it and they are the one who decides whether it is resolved. Make it easy to say it is still broken.
- No corporate filler. No "we appreciate", no "rest assured", no "we are committed to".
- Do not sign off with a name you were not given.`;

export type ReplyPhase = 'acknowledge' | 'fix-notify';

export interface DraftedReply {
  phase: ReplyPhase;
  message: string;
  /** Why this register was chosen — shown to a reviewer before it goes out. */
  tone: string;
  /** The specific points from the reporter's message this answers. */
  addresses: string[];
  /** Where it would go, in the venue's own terms. */
  destination: string;
}

/** Draft the reply. Sends nothing. */
export async function respondToUser(
  scan: Scan,
  issue: Issue,
  phase: ReplyPhase,
  options: { reporter?: Reporter; ticketRef?: string; whatChanged?: string } = {},
): Promise<DraftedReply> {
  const reporter = options.reporter ?? issue.reporter;

  // What they actually wrote is the only thing worth replying to; a reply
  // generated from the triaged summary reads like a form letter because it is.
  const theirWords = issue.evidence
    .map((id) => scan.mentions.find((m) => m.id === id))
    .filter((m): m is NonNullable<typeof m> => Boolean(m))
    .slice(0, 3)
    .map((m) => ({ venue: m.venue, date: m.date, said: m.excerpt.slice(0, 600) }));

  const brief = phase === 'acknowledge'
    ? `Write the ACKNOWLEDGEMENT. Nothing is fixed yet. Confirm the problem is real, apologise once, and say it is `
      + `filed${options.ticketRef ? ` as ${options.ticketRef}` : ''} and that you will come back to them rather than `
      + `making them check.`
    : `Write the FOLLOW-UP. The fix has shipped. Say what changed`
      + `${options.whatChanged ? `: ${options.whatChanged}` : ''}, then ask them to try the thing that broke on them `
      + `and tell you if it is still wrong. Do not assert that it works for them — they decide that.`;

  const drafted = await runAgent<{ message: string; tone: string; addresses: string[] }>(respondAgent, {
    scanId: scan.id,
    note: `${phase} — ${issue.title.slice(0, 50)}`,
    prompt: `Product: "${scan.company}".
Venue: ${reporter?.venue ?? 'unknown'}${reporter ? ` — replying to ${reporter.handle}` : ''}.

The problem, as triaged:
${JSON.stringify({ title: issue.title, summary: issue.summary, impact: issue.impact })}

What they actually wrote:
${JSON.stringify(theirWords)}

${brief}`,
  });

  return {
    phase,
    message: drafted.message,
    tone: drafted.tone,
    addresses: drafted.addresses ?? [],
    destination: reporter
      ? reporter.channel === 'venue-reply'
        ? `reply in thread — ${reporter.sourceUrl}`
        : `${reporter.channel}${reporter.address ? ` — ${reporter.address}` : ''}`
      : 'no contact route established',
  };
}

/** Record an outgoing reply as a step in the audit trail. */
export function replyEvent(reply: DraftedReply, reporter?: Reporter): LoopEvent {
  return {
    id: randomUUID().slice(0, 8),
    step: reply.phase === 'acknowledge' ? 'outreach' : 'fix-notified',
    actor: 'agent',
    at: new Date().toISOString(),
    human: false,
    summary: reply.phase === 'acknowledge'
      ? 'Replied to the reporter: confirmed the problem is real, apologised, gave the ticket.'
      : 'Told the reporter the fix shipped and asked them to confirm it works for them.',
    // The full text, always. A message sent in the company's name is the thing
    // an audit most needs to be able to reread.
    message: reply.message,
    ref: reporter ? { label: reply.destination, url: reporter.sourceUrl } : undefined,
  };
}

/** Actually post the reply to the venue.
 *
 *  Not wired, on purpose. Every other step in this loop is reversible or
 *  internal; this one is speech in the company's name, to a named individual,
 *  on a platform where it cannot really be unsaid. It is also the step where a
 *  model getting the tone wrong is most expensive.
 *
 *  The design intent of the loop is that no member of staff has to act — and
 *  that stays true with a send gate, because the gate is a policy switch set
 *  once, not a person reviewing each message. Whoever turns it on should do so
 *  knowing exactly that. Until then the drafts are real, reviewable, and go
 *  nowhere. */
export async function deliverReply(
  reply: DraftedReply,
  context?: { scan: Scan; issue: Issue; phase: ReplyPhase },
): Promise<{ sent: false; reason: string; reply: DraftedReply; held?: string }> {
  // Not sent — but not thrown away either.
  //
  // The draft is the product's actual output for this step, and "what would we
  // have posted?" is the only way to tell whether these replies are any good.
  // Discarding them means the question can never be asked. So it goes to the
  // outbox: addressed, timestamped, attached to its issue, and clearly marked
  // as never delivered.
  const held = context
    ? holdReply(
      context.scan,
      context.issue,
      reply.message,
      reply.destination,
      context.phase === 'fix-notify' ? 'follow-up' : 'reply',
    )
    : undefined;

  return {
    sent: false,
    reason:
      'Posting is not enabled. The draft above is exactly what would be sent, to '
      + `${reply.destination}, and has been kept in the outbox`
      + `${held ? ` as ${held.id}` : ''}. Turning delivery on is a deliberate choice: it publishes `
      + 'text in the company’s name to a named person, and it is the one step in this loop that '
      + 'cannot be taken back.',
    reply,
    held: held?.id,
  };
}

/** The portable definition, for the agent list and for export to a platform.
 *
 *  Tool-free by contract. This agent writes something that gets posted under
 *  the company's name to the person who complained; everything it says has to
 *  come from the issue and the thread it was handed, never from a search.
 */
export const respondAgent: AgentDefinition = {
  name: 'whisperer-respond',
  title: 'Respond',
  description: 'Drafts the public reply to someone who reported a problem — acknowledgement or shipped-fix follow-up.',
  surface: 'loop',
  instructions: RESPOND_INSTRUCTIONS,
  invocation:
    '\n\nHow you are invoked: the first message names the product and venue, gives the triaged issue, quotes '
    + 'what the reporter wrote, and says which reply to write — the acknowledgement (nothing is fixed yet) or '
    + 'the follow-up (the fix shipped, ask them to check).',
  schema: replySchema,
  connectors: [],
  effort: 'medium',
  inPipeline: true,
};
