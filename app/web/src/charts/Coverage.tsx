import { useEffect, useMemo, useRef, useState } from 'react';
import type { Mention, Scan } from '../../../shared/types.ts';
import { VENUES, venueOf } from '../lib.ts';
import { Why } from './Why.tsx';

/** Where the corpus actually came from, and when.
 *
 *  Every other panel answers "what did we find". This one answers the question
 *  underneath it, which is whether the finding is worth anything: a hundred
 *  references that all landed between 2015 and 2020 is not coverage, it is an
 *  archive, and nothing else on the dashboard would tell you. A count says
 *  "100"; this says "100, none of them from X in the last three months".
 *
 *  A grid rather than a chart. Source down the side in a fixed order, time
 *  across the top, one cell per source per bucket — so a gap is a dark band you
 *  can point at, and the eye finds a missing row far faster than it finds a
 *  missing number.
 *
 *  Two decisions that matter for honesty:
 *
 *  - **Every venue gets a row**, including ones with nothing at all. Rendering
 *    only what was found is what lets a completely missed source stay invisible;
 *    an empty row for X is the whole point of the panel.
 *  - **Undated mentions get their own column** rather than being dropped or
 *    guessed at. They are real finds that cannot be placed, and folding them in
 *    either way would make coverage look better or worse than it is.
 */

const MS_DAY = 86_400_000;

/** The key for one cell of the grid.
 *
 *  A function rather than three copies of a template literal, because the three
 *  copies had drifted into holding a literal NUL byte as their separator —
 *  invisible in every editor, identical on both sides by luck, and one careless
 *  retype away from making every lookup miss. A grid whose every cell silently
 *  reads zero is indistinguishable from a company nobody has ever mentioned. */
const cellKey = (venue: string, bucket: string) => `${venue}\u0000${bucket}`;

/** Which bucket a date falls in, at the grain the window deserves. */
function bucketKey(iso: string, grain: 'week' | 'month'): string {
  const date = new Date(iso);
  if (grain === 'month') return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  // The Monday of that week, so weekly columns line up across sources.
  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

const labelFor = (key: string, grain: 'week' | 'month') =>
  (grain === 'month'
    ? new Date(`${key}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', year: '2-digit' })
    : new Date(`${key}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }));

export function Coverage({ scan, onDig, onDigWindow, pursuing }: {
  scan: Scan;
  /** Search one source harder. Only the sources with their own reader can be
   *  dug into — everything else arrives through general web search, where there
   *  is no per-source limit to lift. */
  onDig?: (venue: string) => void;
  /** Search one source inside one bucket — the cell rather than the row. A dark
   *  band is a source AND a month, and this is the ask that fills it. */
  onDigWindow?: (venue: string, from: string, to: string) => void;
  /** `venue|from|to` keys with work queued or running against them, so a cell
   *  that was clicked says so until the work lands. */
  pursuing?: Set<string>;
}) {
  const [hover, setHover] = useState<{ venue: string; bucket: string; n: number } | null>(null);
  const [aiming, setAiming] = useState<string | null>(null);
  // Which source's accounting is open. Separate from digging, because reading
  // why a band is dark and paying to search it harder are different decisions
  // and the first one informs the second.
  const [picked, setPicked] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const model = useMemo(() => {
    const mentions: Mention[] = scan.mentions ?? [];
    const dated = mentions.filter((m) => m.date);
    if (mentions.length === 0) return null;

    // Grain from the span: a fortnight of discussion bucketed by month is one
    // column, which shows nothing.
    const times = dated.map((m) => new Date(m.date!).getTime()).sort((a, b) => a - b);
    const spanDays = times.length ? (times.at(-1)! - times[0]!) / MS_DAY : 0;
    const grain: 'week' | 'month' = spanDays <= 120 ? 'week' : 'month';

    // Every bucket between the first and the last, including the empty ones —
    // a month nobody wrote anything in is a fact about the window, and skipping
    // it would close the gap up and hide it.
    const buckets: string[] = [];
    if (times.length) {
      const step = new Date(times[0]!);
      const end = new Date(times.at(-1)!);
      for (let guard = 0; step <= end && guard < 400; guard += 1) {
        const key = bucketKey(step.toISOString(), grain);
        if (buckets.at(-1) !== key) buckets.push(key);
        step.setUTCDate(step.getUTCDate() + (grain === 'month' ? 15 : 7));
      }
      const last = bucketKey(end.toISOString(), grain);
      if (buckets.at(-1) !== last) buckets.push(last);
    }

    // Rows: the venues we know about, in their fixed order, plus anything the
    // corpus turned up that is not in that list.
    const seen = new Set(mentions.map((m) => venueOf(m.venue).key));
    const rows: { key: string; label: string; slot: string }[] = [
      ...VENUES.map((v) => ({ key: v.key as string, label: v.label, slot: v.slot })),
      ...[...seen]
        .filter((key) => !VENUES.some((v) => v.key === key))
        .map((key) => ({ key, label: key, slot: 'var(--ink-3)' })),
    ];

    const counts = new Map<string, number>();
    let undated = new Map<string, number>();
    for (const mention of mentions) {
      const venue = venueOf(mention.venue).key;
      if (!mention.date) {
        undated.set(venue, (undated.get(venue) ?? 0) + 1);
        continue;
      }
      const cell = cellKey(venue, bucketKey(mention.date, grain));
      counts.set(cell, (counts.get(cell) ?? 0) + 1);
    }

    const peak = Math.max(1, ...counts.values());
    const total = (key: string) =>
      buckets.reduce((sum, b) => sum + (counts.get(cellKey(key, b)) ?? 0), 0) + (undated.get(key) ?? 0);

    return { buckets, rows, counts, undated, peak, grain, total, anyUndated: undated.size > 0 };
  }, [scan.mentions]);

  // Open at the right-hand edge — the most recent buckets and the totals.
  // A grid that opens on 2024 shows the least interesting end of the history
  // first and looks like it stops there.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [model?.buckets.length]);

  if (!model || model.buckets.length === 0) return null;

  const { buckets, rows, counts, undated, peak, grain, total, anyUndated } = model;

  return (
    <div className="cover">
      <div className="cover-head">
        <h3>Coverage</h3>
      </div>

      {/* Scrolls sideways rather than squeezing.
          Columns used to be `1fr`, so thirty months of history compressed every
          cell to a hairline and the grid still ran off the panel — it looked
          like the data stopped in 2024. Fixed-width columns mean the grid is as
          wide as the history is long, and the source names stay pinned while
          the time axis moves under them. */}
      <div className="cover-scroll" ref={scroller}>
      <div className="cover-grid" // Widths through custom properties so the phone breakpoint can change
        // them. An inline `112px` cannot be overridden by a media query, and
        // 112px of source names on a 360px screen leaves room for about eight
        // weeks of history.
        style={{ gridTemplateColumns: 'var(--cover-name, 112px) repeat(' + (buckets.length + (anyUndated ? 1 : 0)) + ', var(--cover-cell, 13px)) 42px' }}>
        <span className="cover-corner" />
        {/* One label every fourth bucket, counted back from the end.
            Turned on its side so it fits a cell-wide column, and thinned
            because two years of months is twenty-four of them shoulder to
            shoulder. Counting from the END rather than the start is what
            guarantees the most recent bucket is always labelled — that is the
            one being read, and an unlabelled right-hand edge is the one place
            the axis must not be vague. */}
        {buckets.map((b, i) => (
          <span key={b} className="cover-col">
            {(buckets.length - 1 - i) % 4 === 0 ? labelFor(b, grain) : ''}
          </span>
        ))}
        {anyUndated && <span className="cover-col" title="Mentions with no date the source exposed">no date</span>}
        <span className="cover-col">all</span>

        {rows.map((row) => {
          const rowTotal = total(row.key);
          return (
            <Row
              key={row.key}
              row={row}
              buckets={buckets}
              counts={counts}
              undated={undated.get(row.key) ?? 0}
              anyUndated={anyUndated}
              peak={peak}
              grain={grain}
              rowTotal={rowTotal}
              onHover={setHover}
              onAim={setAiming}
              onDig={onDig}
              onDigWindow={onDigWindow}
              pursuing={pursuing}
              picked={picked === row.key}
              onPick={() => setPicked(picked === row.key ? null : row.key)}
            />
          );
        })}
      </div>
      </div>

      {picked && (() => {
        const row = rows.find((r) => r.key === picked);
        if (!row) return null;
        return (
          <Why
            label={row.label}
            audit={(scan.retrieval ?? []).find((a) => a.venue === picked) ?? null}
            kept={total(picked)}
            diggable={Boolean(onDig) && picked !== 'other'}
            onDig={() => onDig?.(picked)}
          />
        );
      })()}

      {/* Below the grid, and at a fixed height.
          This was a line beside the heading that swapped between a description
          and the hovered cell's detail — so every pointer move changed its
          length, and a wrapped line pushed the whole grid down and out from
          under the cursor. */}
      <p className="cover-note">
        {aiming
          ? aiming
          : hover
            ? `${hover.venue} · ${hover.bucket} · ${hover.n} ${hover.n === 1 ? 'mention' : 'mentions'}`
            : 'A dark band is a source nobody looked at properly. Click a source marked ⤓ to search it harder.'}
      </p>
    </div>
  );
}

const WHY: Record<string, string> = {
  hackernews: 'lifts its 365-day window and pulls the whole history',
  github: 'lifts its 40-newest-issues cap',
  reddit: 'searches the subreddit and the site at large harder',
  forum: 'aims the complaint queries at the forums in Sources',
};

function Row({ row, buckets, counts, undated, anyUndated, peak, grain, rowTotal, onHover, onAim, onDig, onDigWindow, pursuing, picked, onPick }: {
  row: { key: string; label: string; slot: string };
  buckets: string[];
  counts: Map<string, number>;
  undated: number;
  anyUndated: boolean;
  peak: number;
  grain: 'week' | 'month';
  rowTotal: number;
  onHover: (v: { venue: string; bucket: string; n: number } | null) => void;
  onAim: (text: string | null) => void;
  onDig?: (venue: string) => void;
  onDigWindow?: (venue: string, from: string, to: string) => void;
  pursuing?: Set<string>;
  picked: boolean;
  onPick: () => void;
}) {
  // Every venue can be dug into. The three with readers of their own get their
  // limits lifted; the rest get the complaint vocabulary aimed at the sites
  // that make up the venue. `other` is the exception — it is the leftovers bin
  // and has no sites to aim at.
  const diggable = Boolean(onDig) && row.key !== 'other';
  return (
    <>
      {/* `cover-empty`, not `empty`. A bare `empty` is a global rule for
          empty-state PANELS — `padding: 40px 16px; text-align: center` — so
          every zero-total row here silently inherited forty pixels of padding
          and pushed its own label down. Modifier classes on a component need
          the component's prefix, or they collide with whatever else in the
          stylesheet claimed the plain English word first. */}
      <span className={`cover-row-name${rowTotal === 0 ? ' cover-empty' : ''}`}>
        {/* Outside the swatch, on the left, at a size that can actually be
            read. A row name reads as a legend label, so nothing about it
            suggested it was the control that deepens that source — and the
            badge that said so was nine pixels of arrow. */}
        <button
          className={`cover-dig${diggable ? ' diggable' : ''}`}
          disabled={!diggable}
          onClick={() => onDig?.(row.key)}
          onPointerEnter={() => onAim(diggable
            ? `Search ${row.label} harder — ${WHY[row.key] ?? 'aims the complaint queries at that venue\u2019s sites'}. Costs that venue's requests only.`
            : `${row.label} is the leftovers bin — there are no sites to aim at.`)}
          onPointerLeave={() => onAim(null)}
          title={diggable ? `Search ${row.label} harder` : `${row.label} is the leftovers bin`}
        >
          {diggable ? '↻' : ''}
        </button>
        {/* The name explains rather than digs. Reading why a band is dark is
            free and reversible; searching harder costs requests and minutes,
            so the free one is what a tap lands on. */}
        <button
          className="cover-row-open"
          aria-expanded={picked}
          onClick={onPick}
          onPointerEnter={() => onAim(`What ${row.label} returned, and what was dropped.`)}
          onPointerLeave={() => onAim(null)}
        >
          <span className="cover-swatch" style={{ background: row.slot }} />
          {row.label}
        </button>
      </span>

      {buckets.map((b) => {
        const n = counts.get(cellKey(row.key, b)) ?? 0;
        // The bucket's own span, so the search is aimed at exactly the band
        // that was clicked. The end is the end of that month or week, not
        // today, which would silently widen the ask.
        const from = grain === 'month' ? `${b}-01` : b;
        const until = () => {
          const stop = new Date(`${from}T00:00:00Z`);
          if (grain === 'month') stop.setUTCMonth(stop.getUTCMonth() + 1);
          else stop.setUTCDate(stop.getUTCDate() + 7);
          stop.setUTCDate(stop.getUTCDate() - 1);
          return stop.toISOString().slice(0, 10);
        };
        const hittable = Boolean(onDigWindow) && row.key !== 'other';
        // Work is queued or running against exactly this source and window.
        const chasing = pursuing?.has(`${row.key}|${from}|${until()}`) ?? false;
        return (
          <span
            key={b}
            role={hittable ? 'button' : undefined}
            tabIndex={hittable ? 0 : undefined}
            title={hittable ? `Search ${row.label} for ${labelFor(b, grain)}` : undefined}
            onClick={hittable ? () => onDigWindow?.(row.key, from, until()) : undefined}
            onKeyDown={hittable ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onDigWindow?.(row.key, from, until());
              }
            } : undefined}
            className={`cover-cell${n === 0 ? ' none' : ''}${hittable ? ' hit' : ''}${chasing ? ' chasing' : ''}`}
            // Square-rooted, because a linear ramp against a peak of 400 makes
            // every ordinary week look empty — and "empty" is the one thing
            // this grid must not say by accident.
            style={n > 0 ? { background: row.slot, opacity: 0.18 + 0.82 * Math.sqrt(n / peak) } : undefined}
            onPointerEnter={() => {
              onHover({ venue: row.label, bucket: labelFor(b, grain), n });
              if (hittable) {
                onAim(n === 0
                  ? `Nothing from ${row.label} in ${labelFor(b, grain)} — click to search that window on its own.`
                  : `${n} from ${row.label} in ${labelFor(b, grain)} — click to search that window harder.`);
              }
            }}
            onPointerLeave={() => { onHover(null); onAim(null); }}
          />
        );
      })}

      {anyUndated && (
        <span
          className={`cover-cell${undated === 0 ? ' none' : ''}`}
          style={undated > 0 ? { background: 'var(--ink-3)', opacity: 0.25 + 0.6 * Math.sqrt(undated / peak) } : undefined}
          onPointerEnter={() => onHover({ venue: row.label, bucket: 'undated', n: undated })}
          onPointerLeave={() => onHover(null)}
        />
      )}

      <span className={`cover-total${rowTotal === 0 ? ' none' : ''}`}>{rowTotal || '—'}</span>
    </>
  );
}
