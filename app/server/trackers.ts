import type { Issue, Scan, Tracker } from '../shared/types.ts';

/** An issue, rendered for whichever tracker it is going to.
 *
 *  Every tracker gets the same body: the problem, who hit it, and links back to
 *  the threads. Only the envelope differs. `clipboard` is the honest default —
 *  it produces exactly what would be sent, without sending it.
 */
export interface FilePayload {
  tracker: Tracker;
  title: string;
  body: string;
  labels: string[];
  /** Where this would go, once credentials exist. */
  endpoint: string;
}

const SEVERITY_LABEL: Record<Issue['severity'], string> = {
  critical: 'sev/critical',
  serious: 'sev/serious',
  warning: 'sev/warning',
  good: 'sev/minor',
};

export function buildPayload(scan: Scan, issue: Issue, tracker: Tracker): FilePayload {
  const evidence = issue.evidence
    .map((id) => scan.mentions.find((m) => m.id === id) ?? null)
    .filter((m): m is NonNullable<typeof m> => Boolean(m));

  const body = [
    issue.summary,
    '',
    `**Impact.** ${issue.impact}`,
    '',
    `**Where it was reported.** ${evidence.length} public ${evidence.length === 1 ? 'thread' : 'threads'}` +
      (issue.firstSeen ? `, first on ${issue.firstSeen.slice(0, 10)}` : '') +
      (issue.lastSeen && issue.lastSeen !== issue.firstSeen ? `, most recently ${issue.lastSeen.slice(0, 10)}` : '') +
      '.',
    '',
    ...evidence.map((m) => `- [${m.venue}] ${m.title} — ${m.url}${m.date ? ` (${m.date.slice(0, 10)})` : ''}\n  > ${m.excerpt.replace(/\n+/g, ' ').slice(0, 300)}`),
    '',
    '---',
    `Filed from the ${scan.company} Whisperer watch. Draft reply prepared for the reporters:`,
    '',
    `> ${issue.draftReply.replace(/\n+/g, '\n> ')}`,
  ].join('\n');

  const labels = [SEVERITY_LABEL[issue.severity], `kind/${issue.kind}`, 'source/public-feedback'];

  const endpoint = {
    linear: 'Linear MCP · issueCreate',
    jira: 'Atlassian MCP · createIssue',
    github: 'GitHub MCP · issues.create',
    clipboard: 'no tracker — copy the payload',
  }[tracker];

  return { tracker, title: issue.title, body, labels, endpoint };
}
