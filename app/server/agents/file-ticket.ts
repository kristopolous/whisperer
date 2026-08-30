/** The file-ticket agent: turn a public complaint into a ticket an engineer
 *  can actually pick up.
 *
 *  `buildPayload` in trackers.ts already renders an issue into a tracker's
 *  envelope, and that is genuinely useful — but it is a template. It restates
 *  the summary and links the threads. What it cannot do is the part that costs
 *  a person twenty minutes: read what several strangers described in their own
 *  words and reconstruct the steps, the expected-versus-actual, and what would
 *  count as fixed.
 *
 *  That reconstruction is what this agent does, and it is the reason the step
 *  is worth automating at all.
 *
 *  Two rules it works under, both load-bearing:
 *
 *   - Repro steps come from what reporters actually described. A plausible
 *     invented step is worse than a missing one, because an engineer will
 *     follow it, fail to reproduce, and close the ticket as "cannot repro"
 *     when the bug was real.
 *   - Filing is separated from drafting. Drafting is free and reversible;
 *     writing to someone's tracker is neither. `fileTicket` produces the
 *     ticket, and `submitTicket` is the only thing that would send it.
 */

import { randomUUID } from 'node:crypto';
import type { Issue, LoopEvent, Scan, Tracker } from '../../shared/types.ts';
import { runAgent } from './runtime.ts';
import type { AgentDefinition } from './types.ts';
import { ticketSchema } from '../schemas.ts';
import { buildPayload, type FilePayload } from '../trackers.ts';
import { createIssue, githubConfigured } from '../channels/github.ts';

export const FILE_TICKET_INSTRUCTIONS = `You turn a public bug report into an engineering ticket.

The reporters are strangers describing a problem in their own words, usually incompletely and often in the middle of an argument about something else. Your job is to extract the defect from that and write it up so someone can work on it without reading the threads.

Rules:
- Repro steps come from what the reporters actually described. If they did not say how they triggered it, say so in the body rather than inventing a sequence. An invented step that does not reproduce gets a real bug closed as "cannot reproduce".
- Expected and actual are one line each, concrete, no hedging.
- Acceptance criteria are checkable. Include the regression test that should exist, named for what it asserts.
- The title is what an engineer would write: imperative, specific, no severity prefix and no marketing tone.
- Quote the reporters where their words are sharper than a paraphrase would be.
- Do not promise a timeline, assign an owner, or estimate effort. You do not know those.`;

export interface DraftedTicket extends FilePayload {
  reproSteps: string[];
  expected: string;
  actual: string;
  acceptance: string[];
}

/** Draft a ticket for one issue. Does not file anything. */
export async function fileTicket(
  scan: Scan, issue: Issue, tracker: Tracker,
): Promise<DraftedTicket> {
  // The reporters' own words, which are the only real source for repro steps.
  const reports = issue.evidence
    .map((id) => scan.mentions.find((m) => m.id === id))
    .filter((m): m is NonNullable<typeof m> => Boolean(m))
    .map((m) => ({ venue: m.venue, url: m.url, date: m.date, title: m.title, said: m.excerpt.slice(0, 700) }));

  const drafted = await runAgent<{
    title: string; body: string; labels: string[];
    reproSteps: string[]; expected: string; actual: string; acceptance: string[];
  }>(fileTicketAgent, {
    scanId: scan.id,
    note: issue.title.slice(0, 60),
    prompt: `Product: "${scan.company}" (${scan.site}).

Issue as triaged:
${JSON.stringify({ title: issue.title, kind: issue.kind, severity: issue.severity, summary: issue.summary, impact: issue.impact })}

What the reporters actually wrote:
${JSON.stringify(reports)}

Write the ticket.`,
  });

  // The envelope (endpoint, label conventions, tracker-specific formatting)
  // stays with trackers.ts; only the contents come from the model.
  const envelope = buildPayload(scan, issue, tracker);

  const body = [
    drafted.body,
    '',
    '## Steps to reproduce',
    ...(drafted.reproSteps.length
      ? drafted.reproSteps.map((step, i) => `${i + 1}. ${step}`)
      : ['_The reporters did not describe how they triggered this._']),
    '',
    `**Expected.** ${drafted.expected}`,
    '',
    `**Actual.** ${drafted.actual}`,
    '',
    '## Done when',
    ...drafted.acceptance.map((line) => `- [ ] ${line}`),
    '',
    '---',
    envelope.body,
  ].join('\n');

  return {
    ...envelope,
    title: drafted.title || envelope.title,
    body,
    labels: [...new Set([...envelope.labels, ...drafted.labels])],
    reproSteps: drafted.reproSteps,
    expected: drafted.expected,
    actual: drafted.actual,
    acceptance: drafted.acceptance,
  };
}

/** Record that a ticket was filed, as a step in the issue's audit trail. */
export function ticketFiledEvent(tracker: Tracker, ref: string, url?: string): LoopEvent {
  return {
    id: randomUUID().slice(0, 8),
    step: 'filed',
    actor: 'agent',
    at: new Date().toISOString(),
    human: false,
    summary: `Filed to ${tracker} with the reproduction and links back to the reporters.`,
    ref: { label: `${ref} — ${tracker}`, url },
  };
}

/** Actually write the ticket to a tracker.
 *
 *  GitHub is implemented, because it is the one where the ticket can also be
 *  the audit record: the issue opens with the public complaint and every later
 *  step of the loop is appended to it as a comment, so "was the person who
 *  reported this ever told anything?" has an answer written down at the time
 *  rather than reconstructed afterwards.
 *
 *  Linear and Jira are not implemented, and that is a decision rather than an
 *  omission — each needs a credential this repo does not hold, and a wrong guess
 *  writes into someone's real backlog. `clipboard` produces exactly what would
 *  be sent and stops, which is what it has always meant here.
 *
 *  Nothing on this path runs unless the request explicitly asked to submit.
 */
export interface SubmitResult {
  filed: boolean;
  reason: string;
  payload: DraftedTicket;
  /** Tracker reference once filed — "#128" for GitHub. */
  ref?: string;
  url?: string;
}

export async function submitTicket(
  payload: DraftedTicket, scan?: Scan, issue?: Issue,
): Promise<SubmitResult> {
  if (payload.tracker !== 'github') {
    return {
      filed: false,
      reason:
        `Filing to ${payload.tracker} is not implemented. The payload above is exactly what would be sent; `
        + 'GitHub is the tracker that is wired up, and switching to it is a one-line change on this request.',
      payload,
    };
  }

  if (!githubConfigured()) {
    return {
      filed: false,
      reason:
        'GitHub filing is built but not configured — set ticketing.github owner/repo in '
        + 'config/channels.json and a GITHUB_TOKEN with Issues: read and write.',
      payload,
    };
  }

  if (!scan || !issue) {
    return { filed: false, reason: 'internal: filing needs the scan and issue for the audit header', payload };
  }

  try {
    const filed = await createIssue(scan, issue, payload.title, payload.body, payload.labels);
    return {
      filed: true,
      reason: `Filed as #${filed.number}. Every later step of the loop will be appended to it as a comment.`,
      payload,
      ref: `#${filed.number}`,
      url: filed.url,
    };
  } catch (error) {
    return {
      filed: false,
      reason: error instanceof Error ? error.message : 'filing failed',
      payload,
    };
  }
}

/** The portable definition, for the agent list and for export to a platform.
 *
 *  Tool-free by contract: a repro step invented from a web search rather than
 *  taken from what the reporters wrote is precisely the failure this agent
 *  exists to prevent, so it must not be able to search.
 */
export const fileTicketAgent: AgentDefinition = {
  name: 'whisperer-file-ticket',
  title: 'File ticket',
  description: "Reconstructs repro steps, expected/actual and acceptance criteria from reporters' own words.",
  surface: 'loop',
  instructions: FILE_TICKET_INSTRUCTIONS,
  invocation:
    '\n\nHow you are invoked: the first message names the product, gives the triaged issue as JSON, and '
    + 'then gives what the reporters actually wrote. Write the ticket from those words.',
  schema: ticketSchema,
  connectors: [],
  effort: 'medium',
  inPipeline: true,
};
