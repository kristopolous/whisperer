import { useMemo, useState } from 'react';
import type { Migration } from '../../../shared/types.ts';
import { fmtDate, plain, venueOf } from '../lib.ts';

/** Who people leave for, and who they arrive from.
 *
 *  Drawn as a diverging bar per competitor — arrivals right, departures left,
 *  off a shared centre line. Direction is a signed quantity here, so it takes
 *  the diverging encoding rather than the categorical palette the topic stack
 *  uses: the axis itself carries the meaning, and a row's side tells you the
 *  answer before you read a number.
 *
 *  Rows are sorted by net, so the competitors bleeding you sit together at the
 *  bottom and the ones feeding you at the top. That ordering is the point of
 *  the chart: an aggregate churn figure would average these into a single
 *  number and hide that two specific tools account for nearly all the losses.
 *
 *  Low-confidence moves — "might switch", "still deciding" — are counted
 *  separately and hatched, because a stated intention is not a migration and
 *  folding the two together inflates churn.
 */
export function MigrationFlow({ migrations, onSearchDeeper, busy }: {
  migrations: Migration[];
  /** Widen the corpus this panel reads. */
  onSearchDeeper?: () => void;
  /** True while that is happening, so the button says so. */
  busy?: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);

  const rows = useMemo(() => {
    const byCompetitor = new Map<string, Migration[]>();
    for (const move of migrations) {
      byCompetitor.set(move.competitor, [...(byCompetitor.get(move.competitor) ?? []), move]);
    }

    return [...byCompetitor.entries()]
      .map(([competitor, moves]) => {
        const inbound = moves.filter((m) => m.direction === 'inbound');
        const outbound = moves.filter((m) => m.direction === 'outbound');
        return {
          competitor,
          moves: [...moves].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')),
          inbound: inbound.length,
          outbound: outbound.length,
          // Only firm moves count toward net; intentions are shown, not counted.
          net: inbound.filter((m) => m.confidence === 'high').length
            - outbound.filter((m) => m.confidence === 'high').length,
          soft: moves.filter((m) => m.confidence === 'low').length,
        };
      })
      .sort((a, b) => b.net - a.net || b.inbound + b.outbound - (a.inbound + a.outbound));
  }, [migrations]);

  if (rows.length === 0) {
    return (
      <div className="empty">
        <h3>Nobody said they moved</h3>
        <p>
          Nothing in the corpus states a switch either way. That is only as good as the corpus —
          say so and it will look harder.
        </p>
        {/* An empty state that cannot be argued with is a shrug. The corpus is
            the input to this panel, so "nothing found" and "not enough was
            collected" look identical from here, and only the person reading it
            knows which one they believe. */}
        {onSearchDeeper && (
          <button className="primary" onClick={onSearchDeeper} disabled={busy}>
            {busy ? 'Looking…' : '⤓ Go look harder'}
          </button>
        )}
      </div>
    );
  }

  const widest = Math.max(...rows.map((row) => Math.max(row.inbound, row.outbound)), 1);
  const totalIn = migrations.filter((m) => m.direction === 'inbound').length;
  const totalOut = migrations.filter((m) => m.direction === 'outbound').length;

  return (
    <div className="migration">
      <div className="migration-head">
        <span className="mig-in">{totalIn} arrived</span>
        <span className="mig-sep">·</span>
        <span className="mig-out">{totalOut} left</span>
        <span className="mig-note">
          bar width is people who said so; hover a row for what they said
        </span>
      </div>

      <div className="mig-rows">
        {rows.map((row) => (
          <div key={row.competitor}>
            <button
              className="mig-row"
              aria-expanded={open === row.competitor}
              onClick={() => setOpen((current) => (current === row.competitor ? null : row.competitor))}
            >
              <span className="mig-out-bar">
                <span
                  className="mig-bar out"
                  style={{ width: `${(row.outbound / widest) * 100}%` }}
                />
                {row.outbound > 0 && <span className="mig-n">{row.outbound}</span>}
              </span>

              <span className="mig-name">{row.competitor}</span>

              <span className="mig-in-bar">
                {row.inbound > 0 && <span className="mig-n">{row.inbound}</span>}
                <span
                  className="mig-bar in"
                  style={{ width: `${(row.inbound / widest) * 100}%` }}
                />
              </span>
            </button>

            {open === row.competitor && (
              <ul className="mig-quotes">
                {row.moves.map((move) => (
                  <li key={move.id} className={move.direction}>
                    <div className="mig-q-head">
                      <span className={`tag ${move.direction === 'inbound' ? 'good' : 'serious'}`}>
                        {move.direction === 'inbound' ? `from ${move.competitor}` : `to ${move.competitor}`}
                      </span>
                      <span className="tag plain">{move.reason}</span>
                      {move.confidence === 'low' && <span className="tag warning">stated intent</span>}
                      <span className="mig-q-at">
                        {venueOf(move.venue).label} · {fmtDate(move.date)}
                      </span>
                    </div>
                    {/* Verbatim: the direction call is only as good as the words
                        it was drawn from, so they stay readable. */}
                    {/* Verbatim, and always openable.
                        The link used to be anchored on the author, and most of
                        these have none — a search result rarely carries one —
                        so the anchor rendered with no text and the quote was a
                        dead end. It matters more here than elsewhere because
                        these quotes arrive already truncated: the ellipsis is
                        in the search snippet the model was given, so the link
                        is the only way to read the rest of the sentence. */}
                    <blockquote>
                      {plain(move.quote)}
                      <cite>
                        {' — '}
                        <a href={move.url} target="_blank" rel="noreferrer">
                          {move.author ?? `read it on ${venueOf(move.venue).label}`}
                        </a>
                      </cite>
                    </blockquote>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>

      <div className="mig-axis">
        <span>← left for them</span>
        <span>arrived from them →</span>
      </div>
    </div>
  );
}
