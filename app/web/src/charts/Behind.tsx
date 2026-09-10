import { useMemo } from 'react';
import type { BuzzPoint, Mention } from '../../../shared/types.ts';
import { fmtDate, fmtScore, plain, venueOf } from '../lib.ts';

/** What a point on the trace is made of.
 *
 *  The tape draws a line that goes up and down and, on its own, asks to be
 *  taken on trust — there was nowhere to look to find out why a month reads
 *  −0.6, or which of a thousand mentions dragged it there. Clicking did filter
 *  something, but the thing it filtered lives on another tab, so from the chart
 *  nothing happened at all.
 *
 *  A point is a mean, so the material that makes it is the individual scores.
 *  They are listed here, in the bucket that was clicked, strongest feeling
 *  first — because the average moved for a reason, and the reason is at the
 *  ends of the distribution rather than the middle. Each one is a link, so
 *  every number on the chart traces back to a page somebody actually wrote.
 */

/** Which points a mention falls between.
 *
 *  Matched on the interval to the next bucket rather than by recomputing the
 *  server's bucket key — week and month keys are built differently on each
 *  side, and a mismatch would silently show an empty list under a point that
 *  plainly has volume. The last bucket runs to the end of the corpus.
 */
function indexFor(dateIso: string, buckets: number[]): number {
  const at = Date.parse(dateIso);
  if (!Number.isFinite(at)) return -1;
  for (let i = buckets.length - 1; i >= 0; i -= 1) {
    if (at >= buckets[i]!) return i;
  }
  return -1;
}

export function Behind({ mentions, buzz, cursor, onClear }: {
  mentions: Mention[];
  buzz: BuzzPoint[];
  cursor: string | null;
  onClear: () => void;
}) {
  const point = buzz.find((p) => p.bucket === cursor);
  const starts = useMemo(() => buzz.map((p) => Date.parse(p.bucket)), [buzz]);

  const rows = useMemo(() => {
    if (!cursor) return [];
    const want = buzz.findIndex((p) => p.bucket === cursor);
    if (want === -1) return [];
    return mentions
      .filter((m) => m.date && indexFor(m.date, starts) === want)
      // Strongest feeling first, either direction. A mean is moved by its
      // extremes, and "show me the most negative thing said that month" is the
      // question somebody is actually asking of this panel.
      .sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
  }, [mentions, buzz, cursor, starts]);

  if (!cursor || !point) return null;

  const scored = rows.filter((m) => m.scored ?? m.score !== 0);

  return (
    <div className="behind">
      <div className="behind-head">
        <strong>{fmtScore(point.score)}</strong>
        <span className="conn-meta">
          the mean of {scored.length} scored of {point.volume} in this bucket
        </span>
        <button className="ghost" onClick={onClear}>clear</button>
      </div>

      {rows.length === 0 ? (
        <p className="q behind-none">
          {/* Said plainly rather than left blank. A point with volume and no
              rows behind it means the mentions could not be placed in time,
              which is a fault worth seeing rather than an empty list. */}
          This bucket has {point.volume} mentions but none of them carry a date we could read,
          so they cannot be placed under this point.
        </p>
      ) : (
        <ul className="behind-list">
          {rows.slice(0, 60).map((m) => (
            <li key={m.id}>
              <span className={`behind-score ${m.score > 0.1 ? 'pos' : m.score < -0.1 ? 'neg' : ''}`}>
                {fmtScore(m.score)}
              </span>
              <span className="behind-body">
                <a href={m.url} target="_blank" rel="noreferrer">{plain(m.title) || m.url}</a>
                <span className="conn-meta">
                  {venueOf(m.venue).label} · {fmtDate(m.date)}
                </span>
                {m.excerpt && <span className="behind-quote">{plain(m.excerpt).slice(0, 240)}</span>}
              </span>
            </li>
          ))}
          {rows.length > 60 && (
            <li className="q">
              {rows.length - 60} more in this bucket, not listed — the sixty strongest are above.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
