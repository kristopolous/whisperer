import type { Scan } from '../../../shared/types.ts';
import { Tape } from '../charts/Tape.tsx';
import { MigrationFlow } from '../charts/MigrationFlow.tsx';
import { TopicStack } from '../charts/TopicStack.tsx';
import { fmtMonth, fmtScore } from '../lib.ts';

/** Overview is the whole report in one look — the tape, the topic mix, the
 *  sentiment read. The headline figures live above the tabs in <StatCards/>,
 *  so they stay on screen whatever tab is open. */
export function Overview({
  scan, cursor, onScrub,
}: {
  scan: Scan;
  cursor: string | null;
  onScrub: (bucket: string | null) => void;
}) {
  const { mentions = [], issues = [] } = scan;
  const buzz = scan.buzz ?? [];
  const direction = scan.net.delta > 0.05 ? 'rising' : scan.net.delta < -0.05 ? 'falling' : 'flat';
  // The n behind the number. A mention keeps score 0 / neutral until something
  // scores it, so this counts what was actually judged rather than collected.
  const scored = (scan.mentions ?? []).filter((m) => m.scored ?? (m.score !== 0 || m.sentiment !== 'neutral')).length;

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

      {scan.migrations.length > 0 && (
        <section>
          <div className="tape">
            <div className="tape-head">
              <h3>Who they switch to, and from</h3>
              <span style={{ font: '400 11px var(--mono)', color: 'var(--ink-3)' }}>
                stated moves · {scan.migrations.length} in the window
              </span>
            </div>
            <MigrationFlow migrations={scan.migrations} />
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
                    {mentions.length === 0
                      ? 'No mentions have been collected, so there is nothing to score.'
                      : `${mentions.length} mentions collected and none scored — the sentiment pass has not run, or it failed. Rerun it from the Discovery tab.`}
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
