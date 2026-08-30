import type { Scan } from '../../../shared/types.ts';
import { Tape } from '../charts/Tape.tsx';
import { counts, fmtMonth, fmtScore } from '../lib.ts';

export type OverviewTab = 'presence' | 'discovery' | 'health' | 'integrity';

/** Overview is the whole report in one look: headline figures for every part of
 *  the product — what accounts exist, how loud the discussion is, what's broken,
 *  who's abusing the name, and where sentiment sits — plus the tape and the read.
 *  Each card is the summary; the tabs drill into the parts. */
export function Overview({
  scan, cursor, onScrub, onDrill,
}: {
  scan: Scan;
  cursor: string | null;
  onScrub: (bucket: string | null) => void;
  onDrill: (tab: OverviewTab) => void;
}) {
  const { profiles = [], mentions = [], issues = [], abuse = [], buzz = [] } = scan;
  const direction = scan.net.delta > 0.05 ? 'rising' : scan.net.delta < -0.05 ? 'falling' : 'flat';
  const venues = counts(mentions);
  const critical = issues.filter((i) => i.severity === 'critical').length;

  const cards: {
    key: OverviewTab | null;
    label: string;
    value: string;
    unit: string;
    line: string;
    tone: 'pos' | 'neg' | 'mid';
  }[] = [
    {
      key: 'presence',
      label: 'Presence',
      value: String(profiles.length),
      unit: profiles.length === 1 ? 'channel' : 'channels',
      line: `${profiles.filter((p) => p.official).length} official · ${profiles.filter((p) => !p.official).length} unofficial`,
      tone: 'mid',
    },
    {
      key: 'discovery',
      label: 'Discussion',
      value: String(mentions.length),
      unit: mentions.length === 1 ? 'mention' : 'mentions',
      line: venues.length
        ? `across ${venues.length} ${venues.length === 1 ? 'venue' : 'venues'} · ${mentions.filter((m) => m.date).length} dated`
        : 'nothing found yet',
      tone: 'mid',
    },
    {
      key: 'health',
      label: 'Issues',
      value: String(issues.length),
      unit: issues.length === 1 ? 'issue' : 'issues',
      line: critical ? `${critical} critical — ready to file` : 'nothing critical',
      tone: critical ? 'neg' : 'mid',
    },
    {
      key: 'integrity',
      label: 'Integrity',
      value: String(abuse.length),
      unit: abuse.length === 1 ? 'finding' : 'findings',
      line: abuse.length
        ? abuse[0].kind.replace(/-/g, ' ') + (abuse.length > 1 ? ' & more' : '')
        : 'name is clean',
      tone: abuse.length ? 'neg' : 'mid',
    },
    {
      key: null,
      label: 'Sentiment',
      value: fmtScore(scan.net.now),
      unit: 'net',
      line: `${direction === 'flat' ? 'holding' : direction}`,
      tone: scan.net.now >= 0 ? 'pos' : 'neg',
    },
  ];

  return (
    <>
      <section className="ocards">
        {cards.map((c) => (
          <button
            key={c.label}
            className="ocard"
            onClick={c.key ? () => onDrill(c.key!) : undefined}
          >
            <span className="ok">{c.label}</span>
            <span className="oval">
              {c.value}
              <span className="ounit">{c.unit}</span>
            </span>
            <span className={`oline ${c.tone}`}>{c.line}</span>
          </button>
        ))}
      </section>

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
                Scored from {mentions.filter((m) => m.date).length} dated mentions.
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
