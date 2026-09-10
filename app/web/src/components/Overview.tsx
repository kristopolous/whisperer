import type { Scan } from '../../../shared/types.ts';
import { Tape } from '../charts/Tape.tsx';
import { MigrationFlow } from '../charts/MigrationFlow.tsx';
import { TopicStack } from '../charts/TopicStack.tsx';
import { fmtMonth, fmtScore } from '../lib.ts';

/** Overview is the whole report in one look — the tape, the topic mix, the
 *  sentiment read. The headline figures live above the tabs in <StatCards/>,
 *  so they stay on screen whatever tab is open. */
export function Overview({
  scan, cursor, onScrub, onSearchDeeper, busy,
}: {
  scan: Scan;
  cursor: string | null;
  onScrub: (bucket: string | null) => void;
  /** Widen the corpus every panel here reads. Offered from the empty states,
   *  where "nothing was said" and "not enough was collected" are
   *  indistinguishable from the outside. */
  onSearchDeeper?: () => void;
  /** True while a run is in flight. */
  busy?: boolean;
}) {
  const { mentions = [], issues = [] } = scan;
  const buzz = scan.buzz ?? [];
  const direction = scan.net.delta > 0.05 ? 'rising' : scan.net.delta < -0.05 ? 'falling' : 'flat';
  // The n behind the number. A mention keeps score 0 / neutral until something
  // scores it, so this counts what was actually judged rather than collected.
  const scored = (scan.mentions ?? []).filter((m) => m.scored ?? (m.score !== 0 || m.sentiment !== 'neutral')).length;

  /** Why nothing is scored — stated, not guessed at.
   *
   *  This used to say "the sentiment pass has not run, or it failed", which is
   *  the panel admitting it did not look. It does not have to guess: the scan
   *  records `timings.buzz` whether the stage succeeded or failed, `failedStage`
   *  says which way it went, `stage` says whether it is happening right now, and
   *  `error` carries the reason. Four distinct situations, four different things
   *  to do about them, and only one of them is "yet".
   *
   *  The same reasoning already lives in the sentiment stat card. It is repeated
   *  here rather than shared because the two say it at different lengths — the
   *  card has a line, this has a sentence — but they must never disagree. */
  const whyUnscored = (): string => {
    if (mentions.length === 0) return 'No mentions have been collected, so there is nothing to score.';
    if (scan.failedStage === 'buzz') {
      return `The sentiment pass ran over ${mentions.length} mentions and failed`
        + `${scan.error ? `: ${scan.error}` : ', with no reason recorded'}. `
        + 'Rerun it from the Discovery tab.';
    }
    if (scan.stage === 'buzz' && scan.status === 'running') {
      return `Scoring ${mentions.length} mentions now.`;
    }
    if (scan.timings?.buzz !== undefined) {
      return `The sentiment pass ran over ${mentions.length} mentions and returned nothing — `
        + 'it did not fail, it produced no scores. Rerun it from the Discovery tab.';
    }
    return `${mentions.length} mentions collected. The sentiment pass has not run yet — `
      + 'run it from the Discovery tab.';
  };

  return (
    <>
      {buzz.length > 0 && (
        <section>
          <div className="tape">
            <div className="tape-head">
              <h3>The tape</h3>
              <span style={{ font: '400 11px var(--mono)', color: 'var(--ink-3)' }}>
                sentiment · {fmtMonth(buzz[0].bucket)} — {fmtMonth(buzz.at(-1)!.bucket)}
              </span>
            </div>
            <Tape buzz={buzz} issues={issues} cursor={cursor} onScrub={onScrub} />
            <div className="tape-foot">
              <span>
                {cursor
                  ? `Filtered to ${fmtMonth(cursor)} — click the trace again to clear`
                  : 'Click the trace to filter the ledger to one month'}
              </span>
              <span style={{ display: 'inline-flex', gap: 14, alignItems: 'center' }}>
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  <i style={{ width: 9, height: 9, borderRadius: 2, background: 'var(--pen)' }} /> incident
                </span>
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  <i style={{ width: 9, height: 9, borderRadius: 2, background: 'var(--pos)' }} /> positive
                </span>
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  <i style={{ width: 9, height: 9, borderRadius: 2, background: 'var(--neg)' }} /> negative
                </span>
              </span>
            </div>
          </div>
        </section>
      )}

      {scan.topics.length > 0 && (
        <section>
          <div className="tape">
            <div className="tape-head">
              <h3>What they're talking about</h3>
              <span style={{ font: '400 11px var(--mono)', color: 'var(--ink-3)' }}>
                volume by topic · stacked
              </span>
            </div>
            <TopicStack topics={scan.topics} />
            <div className="tape-foot">
              <span>Hover a band for the month's breakdown; click a topic to isolate it</span>
            </div>
          </div>
        </section>
      )}

      {/* Shown once the pass that produces it has run, empty or not. Hiding the
          panel when nobody switched makes "we read the corpus and found no
          stated moves" — a real and reassuring answer — look identical to a
          stage that never ran. `timings.buzz` is written whether the stage
          succeeded or failed, so its presence is a reliable "this was read". */}
      {(scan.migrations.length > 0 || scan.timings?.buzz !== undefined) && (
        <section>
          <div className="tape">
            <div className="tape-head">
              <h3>Who they switch to, and from</h3>
              <span style={{ font: '400 11px var(--mono)', color: 'var(--ink-3)' }}>
                {scan.migrations.length > 0
                  ? `stated moves · ${scan.migrations.length} in the window`
                  : 'stated moves · none'}
              </span>
            </div>
            <MigrationFlow migrations={scan.migrations} onSearchDeeper={onSearchDeeper} busy={busy} />
          </div>
        </section>
      )}

      <section>
        <div className="split">
          <div className="panel">
            <div className="figure">
              <div className="k" style={{ font: '400 10.5px var(--mono)', color: 'var(--ink-3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                Net sentiment
              </div>
              {/* Nothing scored means the scoring pass has not run or failed —
                  which is a different thing from "opinion is neutral", and
                  printing 0.00 states the second while meaning the first. Every
                  scan whose buzz stage died was reporting the public as
                  perfectly ambivalent. */}
              {scored === 0 ? (
                <>
                  <div className="value" style={{ color: 'var(--ink-3)' }}>—</div>
                  <div className="delta" style={{ color: 'var(--ink-2)' }}>not scored yet</div>
                  <p className="caption">
                    {whyUnscored()}
                  </p>
                </>
              ) : (
                <>
                  <div className="value" style={{ color: scan.net.now >= 0 ? 'var(--pos)' : 'var(--neg)' }}>
                    {fmtScore(scan.net.now)}
                  </div>
                  <div className="delta" style={{ color: direction === 'flat' ? 'var(--ink-2)' : scan.net.delta > 0 ? 'var(--good)' : 'var(--critical)' }}>
                    {direction === 'flat' ? '—' : scan.net.delta > 0 ? '▲' : '▼'} {fmtScore(scan.net.delta)} across the window · {direction}
                  </div>
                  <p className="caption">
                    Volume-weighted mean of the recent half of the trace, against the earlier half.
                    Scored from {scored} of {mentions.length} mentions.
                  </p>
                </>
              )}
            </div>
          </div>

          {scan.verdict && (
            <div className="panel">
              <header><h3>Read</h3></header>
              <div className="figure" style={{ paddingTop: 14 }}>
                <p style={{ margin: 0, fontSize: 14 }}>{scan.verdict}</p>
              </div>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
