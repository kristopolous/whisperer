import type { Scan } from '../../../shared/types.ts';
import { Tape } from '../charts/Tape.tsx';
import { fmtMonth, fmtScore } from '../lib.ts';

/** Overview is the read in one look: the sentiment trace, the net figure, and
 *  what the model concluded. Discovery/Health/Integrity drill into the parts. */
export function Overview({
  scan, cursor, onScrub,
}: {
  scan: Scan;
  cursor: string | null;
  onScrub: (bucket: string | null) => void;
}) {
  const direction = scan.net.delta > 0.05 ? 'rising' : scan.net.delta < -0.05 ? 'falling' : 'flat';

  return (
    <>
      {scan.buzz.length > 0 && (
        <section>
          <div className="tape">
            <div className="tape-head">
              <h3>The tape</h3>
              <span style={{ font: '400 11px var(--mono)', color: 'var(--ink-3)' }}>
                sentiment · {fmtMonth(scan.buzz[0].bucket)} — {fmtMonth(scan.buzz.at(-1)!.bucket)}
              </span>
            </div>
            <Tape buzz={scan.buzz} issues={scan.issues} cursor={cursor} onScrub={onScrub} />
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

      <section>
        <div className="split">
          <div className="panel">
            <div className="figure">
              <div className="k" style={{ font: '400 10.5px var(--mono)', color: 'var(--ink-3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                Net sentiment
              </div>
              <div className="value" style={{ color: scan.net.now >= 0 ? 'var(--pos)' : 'var(--neg)' }}>
                {fmtScore(scan.net.now)}
              </div>
              <div className="delta" style={{ color: direction === 'flat' ? 'var(--ink-2)' : scan.net.delta > 0 ? 'var(--good)' : 'var(--critical)' }}>
                {direction === 'flat' ? '—' : scan.net.delta > 0 ? '▲' : '▼'} {fmtScore(scan.net.delta)} across the window · {direction}
              </div>
              <p className="caption">
                Volume-weighted mean of the recent half of the trace, against the earlier half.
                Scored from {scan.mentions.filter((m) => m.date).length} dated mentions.
              </p>
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
