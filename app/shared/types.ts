/** Shapes shared by the BFF and the dashboard. The JSON schemas the agent is
 *  held to live in app/server/schemas.ts and mirror these. */

export type Venue =
  | 'reddit' | 'hackernews' | 'x' | 'github' | 'youtube'
  | 'blog' | 'forum' | 'review' | 'other';

export type Sentiment = 'positive' | 'mixed' | 'neutral' | 'negative';

export interface Profile {
  platform: string;
  handle: string;
  url: string;
  confidence: 'high' | 'low';
}

export interface Mention {
  id: string;
  venue: Venue;
  title: string;
  url: string;
  /** ISO date. Null when the source didn't expose one. */
  date: string | null;
  author: string | null;
  excerpt: string;
  /** Comments, upvotes or points — whatever the venue reports. Null if unknown. */
  engagement: number | null;
  sentiment: Sentiment;
  /** -1 (hostile) .. +1 (delighted) */
  score: number;
  themes: string[];
}

export type IssueKind = 'bug' | 'ux' | 'performance' | 'docs' | 'billing' | 'reliability' | 'feature-gap';
export type Severity = 'critical' | 'serious' | 'warning' | 'good';
export type IssueStatus = 'open' | 'filed' | 'responded' | 'closed';

export interface Issue {
  id: string;
  title: string;
  kind: IssueKind;
  severity: Severity;
  summary: string;
  /** What the user actually hits, in their words. */
  impact: string;
  /** Mention ids backing this up. */
  evidence: string[];
  firstSeen: string | null;
  lastSeen: string | null;
  /** A reply to the people who raised it — acknowledgement plus what is being done. */
  draftReply: string;
  status: IssueStatus;
  filedTo?: { tracker: Tracker; ref: string; at: string };
}

export type Tracker = 'linear' | 'jira' | 'github' | 'clipboard';

export type AbuseKind =
  | 'impersonation' | 'phishing' | 'scam' | 'counterfeit'
  | 'fake-support' | 'malware' | 'spam' | 'harassment' | 'credential-theft';

export interface AbuseFinding {
  id: string;
  kind: AbuseKind;
  severity: Severity;
  title: string;
  /** What the operation is doing, concretely. */
  summary: string;
  /** Who it hurts and how. */
  harm: string;
  /** Where it was seen — the impersonating profile, the fake domain, the thread. */
  locations: string[];
  evidence: string[];
  firstSeen: string | null;
  /** What to actually do: report to the platform, register the domain, warn users. */
  recommendation: string;
  status: 'open' | 'reported' | 'dismissed';
}

export interface BuzzPoint {
  /** ISO week or month bucket start. */
  bucket: string;
  /** Mean sentiment score in the bucket, -1..1 */
  score: number;
  volume: number;
  byVenue: Partial<Record<Venue, number>>;
}

export interface Scan {
  id: string;
  company: string;
  site: string;
  createdAt: string;
  status: 'running' | 'done' | 'error';
  stage: Stage;
  error?: string;
  profiles: Profile[];
  mentions: Mention[];
  issues: Issue[];
  abuse: AbuseFinding[];
  buzz: BuzzPoint[];
  /** Everything the run printed, kept with the scan so a finished run can still
   *  be audited. */
  log: LogLine[];
  /** Wall-clock milliseconds per stage, for the run header. */
  timings: Partial<Record<Stage, number>>;
  /** One paragraph on where perception is heading and why. */
  verdict: string;
  /** Net sentiment now, and the change from the first half of the window. */
  net: { now: number; delta: number };
  sessionId?: string;
}

export type Stage = 'queued' | 'presence' | 'discovery' | 'buzz' | 'health' | 'abuse' | 'done';

export type LogLevel = 'info' | 'tool' | 'warn' | 'error' | 'stage';

export interface LogLine {
  at: string;
  level: LogLevel;
  stage: Stage;
  text: string;
}

export const STAGES: { key: Stage; label: string; blurb: string }[] = [
  { key: 'presence',  label: 'Presence',  blurb: 'Reading the site for accounts' },
  { key: 'discovery', label: 'Discovery', blurb: 'Searching for what people said' },
  { key: 'buzz',      label: 'Buzz',      blurb: 'Scoring sentiment over time' },
  { key: 'health',    label: 'Health',    blurb: 'Cataloguing real problems' },
  { key: 'abuse',     label: 'Integrity', blurb: 'Looking for scams and impersonation' },
];

/** Server-sent event payloads. */
export type ScanEvent =
  | { type: 'stage'; stage: Stage; note?: string }
  | { type: 'log'; line: LogLine }
  | { type: 'patch'; scan: Partial<Scan> }
  | { type: 'done'; scan: Scan }
  | { type: 'error'; message: string };
