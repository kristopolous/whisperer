/** A company's runs as a series, and what moved between them.
 *
 *  A single scan is close to meaningless on its own. "741 mentions, net -0.43,
 *  17 defects" is a number you either believe or you do not. The same scan next
 *  to last week's — sentiment down 0.21, defects doubled, three of them new
 *  this morning and one open six runs running — is the thing somebody opens a
 *  reputation tool for.
 *
 *  So this module reads across the runs already stored for one company and
 *  answers two questions: how the numbers moved, and what happened to each
 *  defect. Nothing is fetched and nothing is written; every run it needs is
 *  already on disk, because runs are never discarded — the searches that filled
 *  them cost money and the whole point of keeping them is this comparison.
 *
 *  Note which clock this uses. The buzz and topic charts bucket by when a
 *  mention was WRITTEN, which is archaeology: a complaint posted in March that
 *  we discover today lands in March. Everything here is keyed on when we
 *  OBSERVED it — the run's own timestamp — because that is the only axis that
 *  can answer "what changed since yesterday".
 */

import type { Issue, Scan, Stage } from '../shared/types.ts';

/** One run, reduced to what a series needs. */
export interface Observation {
  scanId: string;
  at: string;
  status: Scan['status'];
  mentions: number;
  /** How many of them the model actually judged. A sentiment over 40 scored
   *  mentions and one over 400 are not the same measurement, and a series that
   *  hides the difference will show a "swing" that is really a sample change. */
  scored: number;
  issues: number;
  critical: number;
  net: number;
}

export type DefectState = 'new' | 'open' | 'gone';

/** One defect followed across runs. */
export interface DefectHistory {
  /** The issue id in the most recent run that carried it, so the dashboard can
   *  link to something openable. */
  id: string;
  title: string;
  severity: Issue['severity'];
  state: DefectState;
  /** When we first and last saw it — observation timestamps, not mention dates. */
  firstObserved: string;
  lastObserved: string;
  /** How many runs it has appeared in. */
  runs: number;
  /** Consecutive most-recent runs it has appeared in. A defect seen in six runs
   *  running reads differently from one seen six times over two months. */
  streak: number;
}

export interface Series {
  observations: Observation[];
  defects: DefectHistory[];
  /** The movement between the last two observations, which is the headline. */
  delta?: {
    since: string;
    mentions: number;
    issues: number;
    net: number;
    newDefects: number;
    goneDefects: number;
  };
}

const observe = (scan: Scan): Observation => ({
  scanId: scan.id,
  at: scan.createdAt,
  status: scan.status,
  mentions: scan.mentions?.length ?? 0,
  scored: (scan.mentions ?? []).filter((m) => m.scored ?? (m.score !== 0 || m.sentiment !== 'neutral')).length,
  issues: scan.issues?.length ?? 0,
  critical: (scan.issues ?? []).filter((i) => i.severity === 'critical').length,
  net: scan.net?.now ?? 0,
});

/* ------------------------------------------------------ defect identity --
 *
 *  Matching a defect across runs is the hard part, because nothing about it is
 *  stable. Its id is minted fresh every run. Its title is written by a model
 *  reading a different batch of complaints, so "Resolve project crashes and
 *  work loss" one day is "Resolve data loss after application freeze" the next.
 *  Its evidence ids are per-run random.
 *
 *  Two signals, either of which is enough:
 *
 *  - A shared source. If two issues cite the same thread, they are about the
 *    same complaint. This is the strong one and it needs the evidence resolved
 *    from per-run ids back to URLs, which is why the scan is passed in.
 *  - Overlapping title vocabulary. Weaker, and it is what carries a recurring
 *    problem that this run happened to find in different threads.
 */

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'from',
  'is', 'are', 'be', 'when', 'during', 'after', 'that', 'this', 'it', 'its',
  // Every title starts with one of these — they are the imperative mood the
  // triage prompt asks for, not a description of the problem.
  'fix', 'resolve', 'address', 'prevent', 'ensure', 'improve', 'allow', 'add',
  'remove', 'correct', 'clarify', 'handle', 'verify', 'increase', 'provide',
]);

const titleTokens = (title: string): Set<string> =>
  new Set(
    title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter((word) => word.length > 2 && !STOP.has(word)),
  );

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

interface Tracked {
  issue: Issue;
  urls: Set<string>;
  tokens: Set<string>;
}

const track = (scan: Scan, issue: Issue): Tracked => {
  const byId = new Map((scan.mentions ?? []).map((m) => [m.id, m.url]));
  const urls = (issue.evidence ?? [])
    // An entry that is already a URL is taken as one. Runs recorded before the
    // triage stage switched to index keys stored an unmatched URL in the
    // evidence list instead of a mention id, so this is the difference between
    // reading the history that is on disk and starting the series from today.
    .map((entry) => byId.get(entry) ?? (/^https?:\/\//i.test(entry) ? entry : undefined))
    .filter((url): url is string => Boolean(url));
  return { issue, urls: new Set(urls), tokens: titleTokens(issue.title) };
};

/** Same underlying problem? Sharing a cited thread settles it; otherwise the
 *  titles have to be substantially the same words. 0.6 rather than something
 *  lower because these titles are short — at three or four content words each,
 *  a looser threshold merges "login failures" with "loading failures". */
const sameDefect = (a: Tracked, b: Tracked): boolean => {
  for (const url of a.urls) if (b.urls.has(url)) return true;
  return overlap(a.tokens, b.tokens) >= 0.6;
};

/** Follow every defect through the runs, oldest first.
 *
 *  Greedy nearest-match rather than anything cleverer: within one run a defect
 *  appears once, the candidate set is a couple of dozen, and a wrong match
 *  costs a mislabelled streak rather than a wrong verdict. */
function followDefects(runs: Scan[]): DefectHistory[] {
  interface Chain { first: string; last: string; runs: number; streak: number; seen: Tracked; id: string }
  const chains: Chain[] = [];

  runs.forEach((scan, index) => {
    const isLatest = index === runs.length - 1;
    const present = (scan.issues ?? []).map((issue) => track(scan, issue));
    const claimed = new Set<Chain>();
    // Match against the chains that existed BEFORE this run, not against the
    // growing list. Otherwise a defect first seen in this run becomes a
    // candidate for the next issue in the same run, and two issues collapse
    // into one chain with runs=2 the moment it appears — which rendered as
    // "NEW, seen in 2 runs", a self-contradiction.
    const existing = chains.slice();

    for (const candidate of present) {
      const match = existing.find((chain) => !claimed.has(chain) && sameDefect(chain.seen, candidate));
      if (match) {
        claimed.add(match);
        // The streak counts consecutive runs. A gap resets it, which is the
        // difference between "still broken" and "back again".
        match.streak = match.last === runs[index - 1]?.createdAt ? match.streak + 1 : 1;
        match.last = scan.createdAt;
        match.runs += 1;
        match.seen = candidate;
        if (isLatest) match.id = candidate.issue.id;
      } else {
        chains.push({
          first: scan.createdAt,
          last: scan.createdAt,
          runs: 1,
          streak: 1,
          seen: candidate,
          id: candidate.issue.id,
        });
      }
    }
  });

  const latest = runs.at(-1)?.createdAt;
  const previous = runs.at(-2)?.createdAt;

  // Can the newest run be trusted to say something is gone?
  //
  // Only if it found anything at all. A run that triaged a real corpus and
  // returned no defects is ambiguous in a way the record does not capture:
  // either the product genuinely has no live complaints, or the triage stage
  // produced nothing without failing loudly enough to be marked. Replit's
  // newest run is the second — 156 scored mentions, no failedStage, zero
  // issues — and read at face value it says every one of its ten defects was
  // fixed overnight.
  //
  // "Everything disappeared at once" is the shape of a broken measurement, not
  // of a good week. Where it cannot be told apart, say nothing rather than
  // announce a fix that did not happen.
  const trustGone = (runs.at(-1)?.issues?.length ?? 0) > 0;

  return chains
    .map((chain) => ({
      id: chain.id,
      title: chain.seen.issue.title,
      severity: chain.seen.issue.severity,
      state: (chain.last !== latest
        // Still open, not gone, when the newest run found nothing to compare
        // against — see trustGone.
        ? (trustGone ? 'gone' : 'open')
        : chain.first === latest && runs.length > 1 ? 'new' : 'open') as DefectState,
      firstObserved: chain.first,
      lastObserved: chain.last,
      runs: chain.runs,
      streak: chain.streak,
    }))
    // What is new comes first, then what is still open, then what went away —
    // the order somebody checking this every morning reads in.
    .sort((a, b) => {
      const rank = { new: 0, open: 1, gone: 2 };
      return rank[a.state] - rank[b.state]
        || b.streak - a.streak
        || a.title.localeCompare(b.title);
    })
    .filter((defect) => defect.state !== 'gone' || (trustGone && defect.lastObserved === previous));
    // Only recently-gone defects are listed. Something that disappeared eight
    // runs ago is not news this morning; it is history, and the observations
    // above already carry it.
}

/** Did this run actually measure anything?
 *
 *  A failed measurement is not an observation, and treating one as an
 *  observation is worse than having no data: a run whose scoring stage died
 *  carries a thousand mentions, none of them scored, so triage has nothing to
 *  rank and reports no defects — and the series then says every defect was
 *  fixed overnight and sentiment returned to zero. That happened, visibly, on
 *  the first pass of this: Replit's latest run showed `0 new, 10 gone` because
 *  the buzz stage had failed and nothing downstream could run.
 *
 *  So a run counts only when it got all the way through. Anything else is a
 *  gap, and a gap is drawn as a gap. */
const REQUIRED: Stage[] = ['discovery', 'buzz', 'health'];

const measured = (scan: Scan): boolean => {
  const mentions = scan.mentions ?? [];
  const scored = mentions.filter((m) => m.scored ?? (m.score !== 0 || m.sentiment !== 'neutral')).length;
  return mentions.length > 0
  // Scoring is the one that fails quietly. A run whose buzz stage died still
  // reports `done` with no failedStage and a full corpus — Replit's 2026-09-02
  // run holds a thousand mentions, none of them scored — and triage then finds
  // nothing to rank, so the series would read "10 defects fixed overnight".
  //
  // "Some" is not enough either, and the series showed why: a Bolt.new run with
  // 60 mentions and exactly ONE of them scored counted as an observation and
  // reported zero defects. Nothing was wrong with it; there was simply not
  // enough in it to have looked. Ten scored, or half the corpus for a subject
  // small enough that ten is most of it.
  && (scored >= 10 || scored >= mentions.length * 0.5)
  // Only the three stages this reads have to have finished. A run that fell
  // over in `presence` or `abuse` measured the defects perfectly well, and
  // throwing it away would have discarded most of the history on disk.
  && !REQUIRED.includes(scan.failedStage as Stage);
};

/** Build the series from every completed run of one company, oldest first. */
export function buildSeries(runs: Scan[]): Series {
  const usable = runs
    .filter(measured)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const observations = usable.map(observe);
  const defects = followDefects(usable);

  const now = observations.at(-1);
  const before = observations.at(-2);

  return {
    observations,
    defects,
    ...(now && before
      ? {
        delta: {
          since: before.at,
          mentions: now.mentions - before.mentions,
          issues: now.issues - before.issues,
          net: now.net - before.net,
          newDefects: defects.filter((d) => d.state === 'new').length,
          goneDefects: defects.filter((d) => d.state === 'gone').length,
        },
      }
      : {}),
  };
}
