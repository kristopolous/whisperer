/** Shapes shared by the BFF and the dashboard. The JSON schemas the agent is
 *  held to live in app/server/schemas.ts and mirror these. */

export type Venue =
  | 'reddit' | 'hackernews' | 'x' | 'github' | 'youtube'
  | 'discord' | 'linkedin'
  | 'telegram' | 'signal' | 'whatsapp'
  | 'blog' | 'forum' | 'review' | 'other';

export type Sentiment = 'positive' | 'mixed' | 'neutral' | 'negative';

/** Why something failed, in the one word that decides how it is presented.
 *
 *  Named rather than spelled out at each use: the server, the stream event and
 *  the dashboard's failure box each had their own copy of this union, so adding
 *  a kind meant finding all three, and missing one showed up as a type error in
 *  an unrelated file. */
export type ErrorKind =
  | 'connector' | 'model' | 'rate' | 'timeout' | 'auth'
  // Not failures of the run: it was refused because another was already going,
  // or the server went away underneath it.
  | 'busy' | 'interrupted'
  | 'other';

export interface Profile {
  platform: string;
  handle: string;
  url: string;
  /** True when the account/group/channel is run by the company itself; false
   *  for third-party, fan, community, review or impostor channels. */
  official: boolean;
  confidence: 'high' | 'low';
}

export interface DropExample {
  url: string;
  title: string;
}

/** One reason, one stage, one source: how many were thrown away and a sample of
 *  which. The sample is what tells a filter working from a filter misfiring. */
export interface Drop {
  stage: Stage | 'unknown';
  reason: string;
  count: number;
  examples: DropExample[];
}

/** What one source yielded, and what became of it. */
export interface VenueAudit {
  venue: string;
  /** Distinct results search returned for this venue, before any filter. */
  returned: number;
  drops: Drop[];
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
  /** Whether complaint triage has already read this one, so a rerun costs the
   *  difference rather than the corpus. */
  triaged?: boolean;
  /** Whether the disambiguation pass has read this one.
   *
   *  Persisted so a rerun costs the difference rather than the corpus. A
   *  mention that was judged to be about this product does not stop being
   *  about it, and re-asking was most of what made repairing anything mean
   *  re-running everything. */
  subjectChecked?: boolean;
  /** Whether the sentiment pass actually judged this one.
   *
   *  Needed because a mention scored a genuine, considered 0.0 and a mention
   *  nothing has looked at both read as `score: 0, sentiment: 'neutral'`.
   *  Inferring "scored" from a non-zero score undercounts every honestly
   *  neutral item — on a real run it reported 27 of 40. */
  scored?: boolean;
  /** True when a complaint-shaped search found this — "X broken", "X doesn't
   *  work". Not a claim that it *is* a complaint, only that it came from asking
   *  for one; triage decides. Carried so the corpus can guarantee these a share
   *  of what the model reads instead of letting recency bury them. */
  complaint?: boolean;
  /** Whether this reads as somebody actually discussing the product, rather
   *  than a listing, directory or "best alternatives" roundup that merely names
   *  it. Decided during discovery and carried through so the dashboard can rank
   *  the same way the corpus was ranked. */
  discussion?: boolean;
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
  /** What reading the source concluded, once someone asked. */
  diagnosis?: Diagnosis;
  /** The patch, and whether its tests actually passed. */
  fix?: FixResult;
  /** How many loop events have already been written to the tracker, so a
   *  second investigation appends what is new rather than repeating the lot. */
  publishedUpTo?: number;
  /** How many times this has been investigated. Each pass is labelled in the
   *  ledger so a re-run reads as a second look rather than a second problem. */
  investigations?: number;
}

/** The result of reading a project's source against a reported defect. */
export interface Diagnosis {
  verdict: 'located' | 'plausible' | 'insufficient' | 'not-a-defect';
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  suspectFiles: { path: string; why: string }[];
  likelyCause: string;
  proposedFix: string;
  regressionTest: string;
  unknowns: string[];
  /** What the search actually covered, so the verdict can be judged. */
  searched: { terms: string[]; files: string[]; hits: number };
  at: string;
}

/** A patch produced for a diagnosed defect, and the evidence it works.
 *
 *  `applied` means the tests passed in a throwaway copy — never that anything
 *  was committed, pushed or merged. `provesTheBug` is the one that matters: a
 *  regression test that passes against the ORIGINAL code has not tested the
 *  fix, and a green suite means nothing without it. */
/** One try at the patch, kept whether it worked or not.
 *
 *  The audit is the product here as much as the patch is. "Fixed in 3 attempts"
 *  tells you nothing about whether to trust it; what the first two tried, and
 *  why each was abandoned, is the difference between a fix somebody can review
 *  and a number they have to take on faith. All of this was already being
 *  logged and then discarded when the run ended. */
export interface FixStep {
  n: number;
  at: string;
  /** Files it changed, and the reason it gave for each. */
  edits: { path: string; why: string }[];
  /** Edits refused because their anchor text did not match exactly once. */
  rejected: string[];
  /** Set when the model call itself failed rather than the patch. */
  modelError?: string;
  testsPassed?: boolean;
  /** Tail of the test output — enough to see the failure, not the whole log. */
  testOutput?: string;
  outcome: 'kept' | 'retried' | 'no-changes' | 'model-failed';
}

export interface FixResult {
  applied: boolean;
  summary: string;
  notes: string;
  files: { path: string; contents: string; why: string }[];
  diff: string;
  tests: { command: string; passed: boolean; output: string };
  provesTheBug: { checked: boolean; failedOnOriginal: boolean; detail: string };
  attempts: number;
  /** Every attempt, in order. The paper trail. */
  trail?: FixStep[];
  /** Whether the suite passed BEFORE anything was touched.
   *
   *  Load-bearing for reading the rest: a green suite after a change means
   *  nothing if it was already red, and it means something different again if
   *  the project has no tests at all. */
  baseline?: { passed: boolean; note: string };
  workdir: string;
  at: string;
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

/** Someone saying, in public, that they moved between this product and another.
 *
 *  Direction is from THIS product's point of view and the two are not
 *  symmetric, so it is stored rather than inferred: `inbound` is a win (they
 *  arrived here from the competitor), `outbound` is a loss (they left here for
 *  the competitor). Getting this backwards would invert the single most
 *  consequential number on the page, so the quote that justifies it is kept
 *  alongside and shown in the UI.
 *
 *  `confidence` is low when the move is stated vaguely ("might switch",
 *  "looking at alternatives") rather than as an accomplished fact. A stated
 *  intention is not a migration, and counting it as one inflates churn. */
export interface Migration {
  id: string;
  direction: 'inbound' | 'outbound';
  /** The other product, as people actually name it. */
  competitor: string;
  /** Where they said it. */
  url: string;
  venue: Venue;
  date: string | null;
  author: string | null;
  /** Verbatim. The claim is only as good as what they actually wrote. */
  quote: string;
  /** Why they moved, in a few words — the reason is the actionable part. */
  reason: string;
  confidence: 'high' | 'low';
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
  /** Whether the quality pass has read this one — see Mention.subjectChecked
   *  for why this is stored rather than recomputed. */
  judged?: boolean;
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
  /** `cancelled` is deliberately not `error`. A run somebody stopped on purpose
   *  has not failed, and reporting it as a failure sends people looking for a
   *  cause that does not exist. It keeps whatever it collected before stopping,
   *  which is often useful on its own. */
  status: 'running' | 'done' | 'error' | 'cancelled';
  stage: Stage;
  /** Short, human-readable explanation of why the scan (or a stage) failed. */
  error?: string;
  /** Full raw error text (model output, stack line) — kept for the details toggle. */
  errorDetail?: string;
  /** The pipeline stage that failed, when known. */
  failedStage?: Stage;
  /** What class of failure this is, so the UI can offer the right remedy. */
  errorKind?: ErrorKind;
  profiles: Profile[];
  mentions: Mention[];
  /** Per-source accounting: what search returned, and what we threw away and
   *  why. The coverage grid's empty rows are unreadable without it — an empty
   *  row means "nobody posted", "nothing came back" or "we dropped it all", and
   *  those call for three different responses. */
  retrieval?: VenueAudit[];
  issues: Issue[];
  abuse: AbuseFinding[];
  buzz: BuzzPoint[];
  /** Discussion volume per topic over time, for the stacked view. */
  topics: TopicPoint[];
  /** Publicly stated moves to and from competing products. */
  migrations: Migration[];
  /** Public scores on review sites — the reputation a buyer actually looks up. */
  reviews: ReviewScore[];
  /** Newest-first stream of the latest comments, videos and posts. */
  feed: FeedItem[];
  /** Exactly what was typed into the box, before anything interpreted it.
   *
   *  Kept because every interpretation downstream is a guess that can be wrong,
   *  and the raw string is the only thing that cannot be. Pasting a repository
   *  URL used to be reduced to "GitHub" by a hostname cleaner before the
   *  resolver ever saw it — so the resolver was asked to identify the wrong
   *  thing and did so correctly. */
  input?: string;
  /** What the typed input was resolved to, once, at the start. */
  subject?: Subject;
  /** A seeded demonstration record, not a run.
   *
   *  Its retrieval data is real but its scores, issues and verdict are written
   *  by hand, so it must never be mistaken for a finding — and, more
   *  importantly, must never stand in for one. The runs rail shows one row per
   *  company and the newest run wins, so an always-freshly-dated fixture for a
   *  company somebody has actually scanned hid the real run behind synthesised
   *  numbers. */
  fixture?: boolean;
  /** When the work currently in flight began.
   *
   *  Recorded rather than inferred. The elapsed clock used to read the first
   *  line of `scan.log`, and a stage rerun does not clear the log — so it
   *  measured from the original run and showed a two-minute rerun as 1455:10.
   *  `createdAt` is no better: that is when the record was minted, which for a
   *  company scanned daily is weeks ago. */
  startedAt?: string;
  /** How hard this run looked. Recorded because it changes what the numbers
   *  mean: a deep run and a normal one are not comparable observations, and a
   *  series that mixes them silently shows a jump that is only effort. */
  depth?: Depth;
  /** Language codes to search in as well as English. Empty or absent means
   *  English only, which is the default because every extra language is real
   *  requests against a paid budget. */
  languages?: string[];
  /** A checkout in the local workspace to diagnose against, by name.
   *
   *  For closed source, where there is no public repository to clone and this
   *  app must not be given a credential that could reach one. Somebody with
   *  access clones it into the workspace themselves; this is the name they gave
   *  it. Always a bare name — it is resolved against the workspace root and
   *  refused if it escapes. See app/server/workspace.ts. */
  workspace?: string;
  /** The fork everything is written to. Never the upstream project. */
  fork?: string;
  /** When each stage last finished, as an ISO timestamp.
   *
   *  Distinct from `timings`, which records how long a stage took. "This took
   *  95 seconds" and "this was fetched three days ago" answer different
   *  questions, and only the second one tells you whether to believe what is on
   *  screen. A scan is a snapshot of a moving internet; without this, a panel
   *  from last week looks exactly like one from a minute ago. */
  pulledAt?: Partial<Record<Stage, string>>;
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

export type Stage = 'queued' | 'subject' | 'presence' | 'discovery' | 'feed' | 'buzz' | 'health' | 'abuse' | 'done';

export type LogLevel = 'info' | 'tool' | 'warn' | 'error' | 'stage';

export interface LogLine {
  at: string;
  level: LogLevel;
  stage: Stage;
  text: string;
}

/** The stages, in the order a run performs them.
 *
 *  `presence` sits at the end, and that is the whole point of the ordering.
 *  Reading a company's own site for its accounts is nearly static — the answer
 *  is the same this morning as it was last week — while the reason to run this
 *  daily is everything downstream of it. Putting the static crawl first meant
 *  every daily run spent its first minutes re-deriving something it already
 *  knew before it got to the part that changes.
 *
 *  Working out *what was typed* is a different job and stayed first, because
 *  discovery cannot form a single query without it. It is also cheap, and on a
 *  re-run it is free: the stored subject is reused unless the input changed.
 *
 *  The one exception is a first scan, which has no footprint yet — see the
 *  ordering in index.ts. Knowing the product's subreddit and GitHub org makes
 *  the discovery queries much sharper, so on a first run the crawl is worth
 *  waiting for; on every run after it is worth deferring. */
export const STAGES: { key: Stage; label: string; blurb: string }[] = [
  { key: 'subject',   label: 'Subject',   blurb: 'Working out what was typed' },
  { key: 'discovery', label: 'Discovery', blurb: 'Searching for what people said' },
  { key: 'feed',      label: 'Feed',      blurb: 'Streaming the latest videos and comments' },
  { key: 'buzz',      label: 'Buzz',      blurb: 'Scoring sentiment over time' },
  { key: 'health',    label: 'Health',    blurb: 'Cataloguing real problems' },
  { key: 'abuse',     label: 'Integrity', blurb: 'Looking for scams and impersonation' },
  // The stage key stays `presence` while the label reads Sources: renaming the
  // key would invalidate `failedStage`, `timings` and `pulledAt` on every scan
  // already on disk, and the series reads those. The word people see is the one
  // that had to change — the page stopped being a report of a footprint and
  // became the editable list of places to look.
  { key: 'presence',  label: 'Sources',   blurb: 'Where to look, and what is missing' },
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
      kind?: ErrorKind;
    };

/** Which reputation a score measures. They are not interchangeable: a company
 *  can be loved by software buyers and hated by its own staff, and averaging
 *  the two describes nobody. */
export type ReviewKind = 'software' | 'customer' | 'app' | 'employer';

/** A public score on a review site, as read out of a search result. */
/** One review, as its author wrote it. */
export interface ReviewSnippet {
  author: string | null;
  /** Normalised to 5, whatever scale the site uses. */
  rating: number | null;
  date: string | null;
  title: string | null;
  body: string;
}

export interface ReviewScore {
  site: string;
  rating: number;
  /** Usually 5, sometimes 10. Stated rather than assumed. */
  scale: number;
  /** How many reviews the score is over — the difference between a signal and
   *  an anecdote. Null when the source did not say. */
  count: number | null;
  url: string;
  /** From the review site's own page, rather than someone quoting it. */
  firstParty: boolean;
  /** The site itself published this number, read from the page's own structured
   *  data — as opposed to the number having been parsed out of a search
   *  result's snippet, which is a guess about what a site says rather than what
   *  it says. Unverified scores are not shown. */
  verified?: boolean;
  /** The sentence it was read out of, so a wrong number is traceable. */
  quote: string;
  kind: ReviewKind;
  /** What people actually wrote, newest first.
   *
   *  A low score is the beginning of a question. These are the answer, and
   *  making somebody open a tab to read them is the difference between a
   *  dashboard and a link collection. */
  recent?: ReviewSnippet[];
}

/** What the person typed, worked out into something the pipeline can use.
 *
 *  Resolved once at the start of a scan so nothing downstream has to interpret
 *  the raw input again. Everything after this point works from `searchTerm` and
 *  `name` rather than from whatever was in the box. */
/** How hard a run looks. `deep` walks the whole recency ladder instead of
 *  stopping at the first window that satisfies the target, and lifts the volume
 *  caps with it. */
export type Depth = 'normal' | 'deep';

export interface Subject {
  /** Exactly what was typed, kept so the resolution can be second-guessed. */
  input: string;
  /** What to call it on screen. */
  name: string;
  /** The term to quote into web searches. */
  searchTerm: string;
  /** Other names the same thing is discussed under. */
  aliases: string[];
  /** Unrelated things sharing the name, which searches should not return. */
  excludeTerms: string[];
  site: string;
  /** Source repository, when known — this is what makes diagnose and fix
   *  available without anyone editing a config file. */
  repo: string;
  kind: 'open-source project' | 'commercial product' | 'company' | 'service' | 'unknown';
  summary: string;
  confidence: 'high' | 'medium' | 'low';
}
