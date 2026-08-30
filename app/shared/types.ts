/** Shapes shared by the BFF and the dashboard. The JSON schemas the agent is
 *  held to live in app/server/schemas.ts and mirror these. */

export type Venue =
  | 'reddit' | 'hackernews' | 'x' | 'github' | 'youtube'
  | 'discord' | 'linkedin'
  | 'telegram' | 'signal' | 'whatsapp'
  | 'blog' | 'forum' | 'review' | 'other';

export type Sentiment = 'positive' | 'mixed' | 'neutral' | 'negative';

export interface Profile {
  platform: string;
  handle: string;
  url: string;
  /** True when the account/group/channel is run by the company itself; false
   *  for third-party, fan, community, review or impostor channels. */
  official: boolean;
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
  /** Who raised it and how to reach them, when a single reporter is identifiable. */
  reporter?: Reporter;
  /** The full audit trail, oldest first. Empty until the loop starts. */
  loop?: LoopEvent[];
}

export type Tracker = 'linear' | 'jira' | 'github' | 'clipboard';

/* ------------------------------------------------- the resolution loop ---- */

/** One rung of the ladder from "a stranger complained in public" to "that same
 *  stranger agreed it is fixed".
 *
 *  The ordering is the contract: a fix is never announced before it exists, and
 *  an issue is never closed on the agent's own say-so — only the person who
 *  reported it can move it to `confirmed`. */
export type LoopStep =
  | 'discovered'     // the complaint was found in public discussion
  | 'reproduced'     // the defect was confirmed against a real build
  | 'filed'          // opened in the tracker, with the report attached
  | 'contact-found'  // a way to reach the reporter was established
  | 'outreach'       // reporter was told it is real, and apologised to
  | 'fixed'          // the change that resolves it landed
  | 'test-added'     // a regression test now guards it
  | 'fix-notified'   // reporter was told it is believed fixed, and asked to check
  | 'confirmed'      // the reporter said it works
  | 'closed';        // loop complete

/** Who took the action.
 *
 *  `reporter` is the only human. That is the whole design: no internal triage
 *  meeting, no support rep in the middle — the one person whose time is spent
 *  is the one who already cared enough to complain. */
export type LoopActor = 'agent' | 'reporter' | 'system';

export interface LoopEvent {
  id: string;
  step: LoopStep;
  actor: LoopActor;
  at: string;
  /** One line describing what happened, for the timeline. */
  summary: string;
  /** Verbatim text when this step was a message to or from a person. Kept in
   *  full: a public apology sent in the company's name is exactly the thing an
   *  audit needs to be able to reread. */
  message?: string;
  /** What the step produced or where it happened — a thread, a tracker ticket,
   *  a commit, a test file. */
  ref?: { label: string; url?: string };
  /** Whether a person had to do something for this step to happen. Only the
   *  reporter's steps should be true; if anything else is, the loop is not
   *  actually closed without staff. */
  human: boolean;
}

/** How to reach the person who reported an issue, and how sure we are that it
 *  is them.
 *
 *  `confidence` matters more than it looks: contacting the wrong person in the
 *  company's name is worse than not contacting anyone. */
export interface Reporter {
  /** Their handle at the venue they complained on. */
  handle: string;
  venue: Venue;
  /** The thread where they said it. */
  sourceUrl: string;
  /** How the agent would reach them, in the venue's own terms. */
  channel: 'venue-reply' | 'email' | 'github-issue' | 'none';
  /** Where that channel points, when it is not just "reply in the thread". */
  address?: string;
  /** How the contact route was established — a public profile, a linked site,
   *  a signature. Recorded so the audit trail can show it was not guessed. */
  basis: string;
  confidence: 'high' | 'low';
}

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

/** How much was said about one product topic in one time bucket.
 *
 *  Sentiment answers "how do they feel"; this answers "about what". Stacked
 *  over time it shows attention moving — a feature that dominated discussion in
 *  spring fading out as a newer one takes over — which is a different and often
 *  more actionable signal than the polarity alone. */
export interface TopicPoint {
  /** Bucket start, same convention as BuzzPoint. */
  bucket: string;
  /** Mentions per topic in this bucket. Absent topic means zero. */
  byTopic: Record<string, number>;
}

export interface BuzzPoint {
  /** ISO week or month bucket start. */
  bucket: string;
  /** Mean sentiment score in the bucket, -1..1 */
  score: number;
  volume: number;
  byVenue: Partial<Record<Venue, number>>;
}

/** One entry in the live feed: the latest thing that surfaced about a company
 *  — a new YouTube video, a comment, a post — with what and when. */
export interface FeedItem {
  id: string;
  venue: Venue;
  /** What kind of thing surfaced — a video upload, a comment, or a post. */
  kind: 'video' | 'comment' | 'post';
  /** For a video this is the title; for a comment, the comment text or headline. */
  headline: string;
  url: string;
  /** ISO date of the post, comment or upload. Null when unknown. */
  date: string | null;
  author: string | null;
  /** The actual comment text (verbatim for comments), or the excerpt shown. */
  snippet: string;
  /** Just enough engagement to show it matters. */
  engagement: number | null;
}

export interface Scan {
  id: string;
  company: string;
  site: string;
  createdAt: string;
  status: 'running' | 'done' | 'error';
  stage: Stage;
  /** Short, human-readable explanation of why the scan (or a stage) failed. */
  error?: string;
  /** Full raw error text (model output, stack line) — kept for the details toggle. */
  errorDetail?: string;
  /** The pipeline stage that failed, when known. */
  failedStage?: Stage;
  /** What class of failure this is, so the UI can offer the right remedy. */
  errorKind?: 'connector' | 'model' | 'rate' | 'timeout' | 'auth' | 'other';
  profiles: Profile[];
  mentions: Mention[];
  issues: Issue[];
  abuse: AbuseFinding[];
  buzz: BuzzPoint[];
  /** Discussion volume per topic over time, for the stacked view. */
  topics: TopicPoint[];
  /** Newest-first stream of the latest comments, videos and posts. */
  feed: FeedItem[];
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

export type Stage = 'queued' | 'presence' | 'discovery' | 'feed' | 'buzz' | 'health' | 'abuse' | 'done';

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
  { key: 'feed',      label: 'Feed',      blurb: 'Streaming the latest videos and comments' },
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
  | {
      type: 'error';
      message: string;
      /** The pipeline stage that failed, when it can be pinned down. */
      stage?: Stage;
      /** The full raw error text, for the details toggle. */
      detail?: string;
      /** What class of failure this is, so the UI can offer the right remedy. */
      kind?: 'connector' | 'model' | 'rate' | 'timeout' | 'auth' | 'other';
    };
