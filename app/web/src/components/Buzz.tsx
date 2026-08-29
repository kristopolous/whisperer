import { useState } from 'react';
import type { Scan } from '../../../shared/types.ts';
import { VenueBars } from '../charts/VenueBars.tsx';
import { VENUES, fmtDate, fmtMonth, fmtScore, venueOf } from '../lib.ts';

/** Buzz answers one question — is opinion drifting, and which way. The hero
 *  figure states it; the ledger is the table view that backs it up. */
export function Buzz({ scan, cursor }: { scan: Scan; cursor: string | null }) {
  const [venue, setVenue] = useState<string>('all');

  const visible = scan.mentions.filter((m) => {
    if (cursor && (!m.date || !m.date.startsWith(cursor.slice(0, 7)))) return false;
    if (venue !== 'all' && venueOf(m.venue).key !== venue) return false;
    return true;
  });

  const direction = scan.net.delta > 0.05 ? 'rising' : scan.net.delta < -0.05 ? 'falling' : 'flat';

  return (
    <div className="stack">
      <div className="split">
        <div className="panel">
          <header>
            <h3>Ledger</h3>
            <span style={{ font: '400 11px var(--mono)', color: 'var(--ink-3)' }}>
              {visible.length} of {scan.mentions.length}
              {cursor ? ` · ${fmtMonth(cursor)}` : ''}
            </span>
          </header>

          <div className="legend" role="group" aria-label="Filter by venue">
            <button
              className="tag plain"
              aria-pressed={venue === 'all'}
              onClick={() => setVenue('all')}
              style={{ borderColor: venue === 'all' ? 'var(--signal)' : undefined, color: venue === 'all' ? 'var(--ink)' : undefined }}
            >
              All
            </button>
            {VENUES.filter((v) => scan.mentions.some((m) => venueOf(m.venue).key === v.key)).map((v) => (
              <button
                key={v.key}
                className="tag"
                aria-pressed={venue === v.key}
                onClick={() => setVenue(venue === v.key ? 'all' : v.key)}
                style={{ color: v.slot, borderColor: venue === v.key ? v.slot : undefined }}
              >
                {v.label}
              </button>
            ))}
          </div>

          <div className="scroll wide">
            <table>
              <thead>
                <tr>
                  <th>Venue</th>
                  <th>What was said</th>
                  <th>Date</th>
                  <th style={{ textAlign: 'right' }}>Score</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <span className="tag" style={{ color: venueOf(m.venue).slot }}>{venueOf(m.venue).label}</span>
                    </td>
                    <td>
                      <a href={m.url} target="_blank" rel="noreferrer">{m.title}</a>
                      <div className="quote">{m.excerpt.slice(0, 190)}{m.excerpt.length > 190 ? '…' : ''}</div>
                      {m.themes.length > 0 && (
                        <div style={{ marginTop: 6, display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                          {m.themes.slice(0, 4).map((t) => (
                            <span className="tag plain" key={t}>{t}</span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="num">{m.date ? fmtDate(m.date) : '—'}</td>
                    <td className="num">
                      <span className={`sent ${m.sentiment}`}>{fmtScore(m.score)}</span>
                    </td>
                  </tr>
                ))}
                {visible.length === 0 && (
                  <tr><td colSpan={4} className="empty">Nothing in this slice. Clear the filters to see everything.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="stack">
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

          <div className="panel">
            <header><h3>Where they talk</h3></header>
            <VenueBars mentions={scan.mentions} />
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
      </div>
    </div>
  );
}
