import type { Scan, Stage } from '../../../shared/types.ts';
import { counts, fmtAgo, fmtScore } from '../lib.ts';

export type OverviewTab = 'presence' | 'discovery' | 'defects' | 'integrity';

/** The headline figures for a whole scan — presence, discussion, issues,
 *  integrity and sentiment. Kept above the tabs so the summary is always on
 *  screen no matter which part is being drilled into; clicking a card jumps to
 *  that tab (sentiment has nowhere interesting to go, so it stays flat). */
/** The headline figures, and only the ones that mean something yet.
 *
 *  A card with no data behind it used to render anyway — "0 gripes", "+0.00
 *  net" — which is worse than showing nothing, because a zero is a claim. Every
 *  scan whose scoring stage failed reported neutral public sentiment, and a
 *  corpus collected before complaint detection existed reported no complaints.
 *
 *  So a card appears when it has a real answer. Until then, if its stage is the
 *  one currently running, it shows what is arriving instead — which is the
 *  thing worth looking at during the minutes a scan takes. If its stage has not
 *  run at all, there is no card. */
export function StatCards({
  scan,
  stage,
  running,
  onDrill,
  onRun,
}: {
  scan: Scan;
  stage: Stage;
  running: boolean;
  onDrill: (tab: OverviewTab) => void;
  /** Run the stage that would fill an empty card. */
  onRun: (which: Stage) => void;
}) {
  // Presence is no longer a card here; the tab and the header indicator carry it.
  const mentions = scan.mentions ?? [];
  const issues = scan.issues ?? [];
  const abuse = scan.abuse ?? [];
  const reviews = scan.reviews ?? [];
  // The weakest score, as a share of its own scale — 8.2/10 and 4.1/5 are not
  // comparable as raw numbers. The worst one is the headline because that is
  // the one costing them something.
  const lowest = [...reviews].sort((a, b) => a.rating / a.scale - b.rating / b.scale)[0];
  const venues = counts(mentions);
  const critical = issues.filter((i) => i.severity === 'critical').length;
  const direction = scan.net.delta > 0.05 ? 'rising' : scan.net.delta < -0.05 ? 'falling' : 'flat';
  // How many mentions actually carry a score, which is the n behind the
  // sentiment number — not the size of the corpus, and certainly not the size
  // of the internet.
  const scored = scan.mentions.filter((m) => m.scored ?? (m.score !== 0 || m.sentiment !== 'neutral')).length;

  // Complaint-bearing mentions, which is the product's actual subject and — the
  // point of putting it here — is known without the model. Sentiment, topics
  // and triage all wait on a scoring pass that takes minutes and can fail;
  // this is decided during discovery and is available the moment the corpus is.
  const complaints = mentions.filter((m) => m.complaint).length;
  // Scans collected before complaint detection existed carry no flag at all.
  // "0 gripes" would be a finding; "not classified" is the truth, and it is the
  // same distinction the sentiment card gets wrong when it prints 0.00 for a
  // scoring pass that never ran.
  const classified = mentions.some((m) => m.complaint !== undefined);

  const ages = mentions
    .map((m) => (m.date ? Date.now() - Date.parse(m.date) : null))
    .filter((ms): ms is number => ms !== null && Number.isFinite(ms) && ms >= 0)
    .sort((a, b) => a - b);
  const newest = ages[0];
  const week = ages.filter((ms) => ms <= 7 * 86_400_000).length;
  const fmtAge = (ms: number) =>
    (ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))}m`
      : ms < 86_400_000 ? `${Math.round(ms / 3_600_000)}h`
        : `${Math.round(ms / 86_400_000)}d`);

  const done = (which: Stage) => scan.timings?.[which] !== undefined;
  const busy = (which: Stage) => running && stage === which;

  const cards: {
    key: OverviewTab | null;
    label: string;
    value: string;
    unit: string;
    line: string;
    tone: 'pos' | 'neg' | 'mid';
    /** The stage that fills this card. */
    from: Stage;
    /** Whether there is a real answer to show. */
    ready: boolean;
  }[] = [
    /* Presence used to lead this row and does not belong there. It is not a
       result — nobody watches a company to learn that it has nine channels —
       it is the list of places to go and look, and it changes about as often
       as the company's own website does. The count still shows in the header
       indicator and the tab itself; what it stopped doing is occupying the
       first of four cards that are meant to say how things are going. */
    {
      key: 'discovery',
      label: 'Discussion',
      value: String(mentions.length),
      unit: mentions.length === 1 ? 'mention' : 'mentions',
      // Recency belongs on the face of this one. A brand watch whose newest
      // item is eight months old is not a brand watch, and a raw count hides
      // that completely.
      line: venues.length
        ? `${venues.length} ${venues.length === 1 ? 'venue' : 'venues'}`
          + (newest === undefined ? ' · undated' : ` · newest ${fmtAge(newest)} · ${week} this week`)
        : 'nothing found yet',
      tone: 'mid',
      from: 'discovery',
      ready: mentions.length > 0,
    },
    {
      // Drills to Discovery, not Health. A complaint is a mention somebody
      // wrote; an issue is a defect triaged out of several of them. Sending
      // "128 gripes" to a tab that answers "no defects found" describes a
      // different question and reads as a contradiction.
      key: 'discovery',
      label: 'Complaints',
      value: classified ? String(complaints) : '—',
      unit: classified ? (complaints === 1 ? 'gripe' : 'gripes') : '',
      line: !mentions.length
        ? 'nothing found yet'
        : !classified
          ? 'not classified — rerun discovery'
          : `${Math.round((complaints / mentions.length) * 100)}% of what was found`,
      // Red only when the share is genuinely alarming. Any complaints at all
      // turning the line red made "29% of what was found" — a perfectly
      // ordinary proportion for a mature product — read as a fault.
      tone: classified && mentions.length && complaints / mentions.length >= 0.4 ? 'neg' : 'mid',
      from: 'discovery',
      ready: classified,
    },
    {
      key: 'defects',
      label: 'Issues',
      value: String(issues.length),
      unit: issues.length === 1 ? 'issue' : 'issues',
      line: critical ? `${critical} critical — ready to file` : 'nothing critical',
      tone: critical ? 'neg' : 'mid',
      // The stage is still called `health`; only the tab was renamed.
      from: 'health',
      ready: done('health'),
    },
    {
      key: 'integrity',
      label: 'Reputation',
      // The score people actually look up, not the count of a thing that is
      // almost always zero. "0 findings · name is clean" was technically true
      // and told nobody anything.
      value: reviews.length ? `${lowest!.rating}` : String(abuse.length),
      unit: reviews.length ? `/${lowest!.scale} ${lowest!.site.toLowerCase()}` : abuse.length === 1 ? 'finding' : 'findings',
      line: reviews.length
        ? `lowest of ${reviews.length} public score${reviews.length === 1 ? '' : 's'}`
          + (abuse.length ? ` · ${abuse.length} abuse finding${abuse.length === 1 ? '' : 's'}` : '')
        : abuse.length
          ? abuse[0].kind.replace(/-/g, ' ') + (abuse.length > 1 ? ' & more' : '')
          : 'name is clean',
      tone: abuse.length ? 'neg'
        : lowest && lowest.rating / lowest.scale < 0.6 ? 'neg'
          : lowest && lowest.rating / lowest.scale >= 0.8 ? 'pos' : 'mid',
      from: 'abuse',
      ready: done('abuse'),
    },
    {
      key: null,
      label: 'Sentiment',
      // An em dash rather than +0.00 when nothing has been scored. A zero here
      // reads as "opinion is neutral", which is a finding; the truth is that
      // the scoring pass has not run or failed, which is a different thing
      // entirely and was showing on every scan whose buzz stage died.
      value: scored === 0 ? '—' : fmtScore(scan.net.now),
      unit: scored === 0 ? '' : 'net',
      // The sample size belongs on the face of the number, not in a footnote.
      // This is a mean over the mentions that were read, and the mentions that
      // were read are whatever search ranked highest for a set of deliberately
      // complaint-biased queries — not a random draw from everyone who has an
      // opinion. Printing "+0.03" alone invites reading it as "the public feels
      // slightly positive", which it cannot support at any N.
      // "not scored yet" is what every one of these situations looked like, and
      // they are not the same situation: a stage that never ran, one that ran
      // and died, one that ran over an empty corpus, and one still going. Only
      // the first is "yet". The scan already records which — `timings.buzz` is
      // written whether the stage succeeded or failed, and `failedStage` says
      // which way — so the card can say it instead of shrugging.
      line: scored === 0
        ? (scan.failedStage === 'buzz'
          ? `scoring failed — ${(scan.error ?? 'no reason recorded').slice(0, 60)}`
          : mentions.length === 0
            ? 'nothing was found to score'
            : done('buzz')
              ? `scoring ran over ${mentions.length} mentions and returned nothing`
              : stage === 'buzz'
                ? `scoring ${mentions.length} mentions now…`
                : `${mentions.length} mentions collected, not scored yet`)
        : `${direction === 'flat' ? 'holding' : direction} · n=${scored}`,
      tone: scored === 0 ? (scan.failedStage === 'buzz' ? 'neg' : 'mid') : scan.net.now >= 0 ? 'pos' : 'neg',
      from: 'buzz',
      ready: scored > 0,
    },
  ];

  return (
    <section className="ocards">
      {cards.map((c) => {
        // Three states, and the difference matters. A card with a real answer
        // shows it. A card whose stage is running right now shows that, so the
        // minutes a scan takes are legible rather than blank. A card whose
        // stage has not run keeps its place, dimmed, saying what will fill it —
        // so the shape of the finished page is visible from the start and an
        // empty slot never reads as a result.
        const state = c.ready ? 'ready' : busy(c.from) ? 'live' : 'pending';

        return (
          <button
            key={c.label}
            className="ocard"
            data-state={state}
            // A card with nothing in it is the obvious place to click to get
            // something in it. Disabling it made the emptiest part of the page
            // the only part you could not act on.
            disabled={running}
            title={c.ready ? undefined : `Run ${WAITING_ON[c.from]}`}
            onClick={() => (c.ready && c.key ? onDrill(c.key) : c.ready ? undefined : onRun(c.from))}
          >
            <span className="ok">{c.label}</span>
            <span className="oval">
              {c.ready ? c.value : <span className="opending" aria-hidden="true" />}
              {c.ready && <span className="ounit">{c.unit}</span>}
            </span>
            {c.ready && fmtAgo(scan.pulledAt?.[c.from]) && (
              <span className="opulled" title={scan.pulledAt?.[c.from]}>
                pulled {fmtAgo(scan.pulledAt?.[c.from])}
              </span>
            )}
            <span className={`oline ${c.ready ? c.tone : 'mid'}`}>
              {c.ready
                ? c.line
                : state === 'live'
                  ? `${WAITING_ON[c.from]}…`
                  : running ? `from ${WAITING_ON[c.from]}` : `run ${WAITING_ON[c.from]} →`}
            </span>
          </button>
        );
      })}
    </section>
  );
}

/** What each not-yet-filled card is waiting for, in the words the run log uses,
 *  so the card and the console agree about what is happening. */
const WAITING_ON: Record<Stage, string> = {
  queued: 'the queue',
  subject: 'working out what was typed',
  presence: 'finding where to look',
  discovery: 'searching for discussion',
  feed: 'the feed',
  buzz: 'scoring sentiment',
  health: 'triaging complaints',
  abuse: 'the integrity sweep',
  done: 'the run',
};
