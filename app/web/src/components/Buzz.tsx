import { useMemo, useState } from 'react';
import type { Scan } from '../../../shared/types.ts';
import { VenueBars } from '../charts/VenueBars.tsx';
import { Filter, matches } from './Filter.tsx';
import { Coverage } from '../charts/Coverage.tsx';
import { VENUES, fmtDate, fmtMonth, fmtScore, venueOf } from '../lib.ts';

/** Discovery is the raw material for everything else: every mention and where
 *  it lives. The ledger shows the remarks; the venue bars show the mix. */
export function Buzz({ scan, cursor, onDig }: {
  scan: Scan;
  cursor: string | null;
  /** Search one source harder — the coverage grid's row click. */
  onDig?: (venue: string) => void;
}) {
  const [venue, setVenue] = useState<string>('all');
  const [query, setQuery] = useState('');

  // Real discussion first, then newest first.
  //
  // This is a brand watch, so what was said last week is the point and what was
  // said eighteen months ago is history. But sorting on date alone floats the
  // "Product Review 2026" and directory-listing pages, which are always freshly
  // regenerated and never anybody's opinion — recent and worthless. Ranking
  // discussion above them, and recency within each, puts the newest thing a
  // real person said at the top, which is the actual question being asked.
  //
  // Undated rows go last within their group: they are shown, but they cannot
  // claim the top of a list whose ordering is recency.
  const visible = useMemo(
    () => scan.mentions
      .filter((m) => {
        if (cursor && (!m.date || !m.date.startsWith(cursor.slice(0, 7)))) return false;
        if (venue !== 'all' && venueOf(m.venue).key !== venue) return false;
        // Searches what a person can see plus the themes and the URL, so
        // "reddit crash" and "r/GIMP" both work.
        if (!matches(query, m.title, m.excerpt, m.url, m.themes.join(' '))) return false;
        return true;
      })
      .sort((a, b) => {
        // Complaints first, then real discussion, then newest.
        //
        // Recency alone put fresh but useless pages — a Wikipedia edit, a
        // listicle that name-drops the product — above the threads this whole
        // product exists to find. Complaints accumulate rather than trend, so a
        // pure recency sort structurally buries them: the newest thing said
        // about a product is almost never the complaint.
        const complaint = Number(b.complaint ?? false) - Number(a.complaint ?? false);
        if (complaint !== 0) return complaint;
        const discussion = Number(b.discussion ?? true) - Number(a.discussion ?? true);
        if (discussion !== 0) return discussion;
        if (Boolean(a.date) !== Boolean(b.date)) return a.date ? -1 : 1;
        return (b.date ?? '').localeCompare(a.date ?? '');
      }),
    [scan.mentions, cursor, venue, query],
  );

  return (
    // One column, not two.
    //
    // The narrow right-hand column held a venue bar chart, and the coverage
    // grid now says the same thing with a time axis on it — so the split was
    // paying a third of the width to repeat, in less detail, what the wide
    // panel already showed. The grid is the widest thing on the page and wants
    // every pixel: each extra column is another month of history legible at a
    // glance.
    <div className="stack">
      <div className="panel">
        <Coverage scan={scan} onDig={onDig} />
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

        <Filter
          value={query}
          onChange={setQuery}
          placeholder="Search titles, quotes, themes, URLs…"
          showing={visible.length}
          total={scan.mentions.length}
        />

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

      <div className="panel">
        <header><h3>Where they talk</h3></header>
        <VenueBars mentions={scan.mentions} />
        {scan.mentions.length === 0 && (
          <div className="empty">
            <h3>No discussion found</h3>
            <p>Discovery didn't surface any third-party mentions, so there is nothing to list.</p>
          </div>
        )}
      </div>
    </div>
  );
}
