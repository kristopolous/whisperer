import { useMemo, useRef, useState } from 'react';
import type { TopicPoint } from '../../../shared/types.ts';
import { fmtBucket, grainOf } from '../lib.ts';
import { useTooltip } from './tooltip.tsx';

/** Discussion volume per topic, stacked over time.
 *
 *  The tape above answers "how do they feel". This answers "about what", and
 *  the stacked form is the whole point: it shows attention *moving*. A band
 *  that swells while its neighbour shrinks is interest transferring from one
 *  feature to another, which a set of separate lines makes you reconstruct in
 *  your head and a total-volume line hides entirely.
 *
 *  Volume is a magnitude, not a polarity, so this takes the categorical palette
 *  — one fixed hue per topic — rather than the diverging encoding the sentiment
 *  tape uses for its signed values.
 *
 *  Bands are ordered largest-total at the bottom. Stacked areas are read most
 *  accurately along the baseline, so the topic carrying the most discussion
 *  gets the position where its shape is legible, and the small volatile ones
 *  ride on top where their wobble does not distort everything beneath them.
 */

const SLOTS = [
  'var(--s-1)', 'var(--s-2)', 'var(--s-3)', 'var(--s-4)', 'var(--s-5)', 'var(--s-6)',
  'var(--s-7)', 'var(--s-11)', 'var(--s-12)', 'var(--s-10)',
];

export function TopicStack({ topics }: { topics: TopicPoint[] }) {
  const W = 1000, H = 200, PAD = { t: 16, r: 12, b: 26, l: 40 };
  const svgRef = useRef<SVGSVGElement>(null);
  // Read from the buckets themselves — days, weeks or months depending on
  // what the scan actually covered.
  const grain = grainOf(topics.map((p) => p.bucket));
  const [hover, setHover] = useState<number | null>(null);
  const [muted, setMuted] = useState<string | null>(null);
  const tip = useTooltip();

  const plot = { w: W - PAD.l - PAD.r, h: H - PAD.t - PAD.b };

  /** Topic order and per-bucket cumulative bounds, computed once. */
  const model = useMemo(() => {
    const totals = new Map<string, number>();
    for (const point of topics) {
      for (const [name, count] of Object.entries(point.byTopic)) {
        totals.set(name, (totals.get(name) ?? 0) + count);
      }
    }
    // Biggest along the baseline where a stacked band is easiest to read.
    const names = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);

    const peak = Math.max(
      1,
      ...topics.map((point) => Object.values(point.byTopic).reduce((sum, n) => sum + n, 0)),
    );

    return { names, totals, peak };
  }, [topics]);

  if (topics.length === 0 || model.names.length === 0) {
    return (
      <div className="empty">
        <h3>Nothing to stack</h3>
        <p>
          No dated discussion carried a topic, so there is no volume to break down. This fills in
          once a scan has mentions with both a date and a classified theme.
        </p>
      </div>
    );
  }

  const x = (i: number) =>
    PAD.l + (topics.length < 2 ? plot.w / 2 : (i / (topics.length - 1)) * plot.w);
  const y = (value: number) => PAD.t + plot.h - (value / model.peak) * plot.h;

  /** Cumulative upper edge for each topic at each bucket. */
  const stacked = model.names.map((name, layer) => {
    const upper = topics.map((point) =>
      model.names
        .slice(0, layer + 1)
        .reduce((sum, key) => sum + (point.byTopic[key] ?? 0), 0));
    const lower = topics.map((point) =>
      model.names
        .slice(0, layer)
        .reduce((sum, key) => sum + (point.byTopic[key] ?? 0), 0));

    const top = upper.map((value, i) => `${i ? 'L' : 'M'}${x(i)},${y(value)}`).join(' ');
    const bottom = lower
      .map((value, i) => `L${x(lower.length - 1 - i)},${y(lower[lower.length - 1 - i]!)}`)
      .join(' ');

    return { name, slot: SLOTS[layer % SLOTS.length]!, d: `${top} ${bottom} Z`, upper };
  });

  const nearest = (event: React.PointerEvent) => {
    const box = svgRef.current!.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * W;
    let best = 0;
    for (let i = 1; i < topics.length; i += 1) {
      if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
    }
    return best;
  };

  const onMove = (event: React.PointerEvent) => {
    const index = nearest(event);
    setHover(index);
    const point = topics[index]!;
    const total = Object.values(point.byTopic).reduce((sum, n) => sum + n, 0);
    const rows = model.names
      .map((name) => ({ name, count: point.byTopic[name] ?? 0 }))
      .filter((row) => row.count > 0)
      .sort((a, b) => b.count - a.count);

    tip.show(
      event,
      <>
        <div className="k">{fmtBucket(point.bucket, grain)}</div>
        <div><span className="v">{total}</span> {total === 1 ? 'mention' : 'mentions'}</div>
        <div className="tip-topics">
          {rows.map((row) => (
            <div key={row.name} className="tip-topic">
              <span
                className="topic-swatch"
                style={{ background: SLOTS[model.names.indexOf(row.name) % SLOTS.length] }}
              />
              <span>{row.name}</span>
              <span className="v">{row.count}</span>
            </div>
          ))}
        </div>
      </>,
    );
  };

  const leave = () => { setHover(null); tip.hide(); };

  // Round tick values, so the axis reads in whole mentions.
  const ticks = [0, Math.round(model.peak / 2), model.peak];

  return (
    <div className="topic-stack">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="topic-chart"
        role="img"
        aria-label={`Discussion volume by topic across ${topics.length} months`}
        onPointerMove={onMove}
        onPointerLeave={leave}
      >
        {ticks.map((value) => (
          <g key={value}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(value)} y2={y(value)} className="gridline" />
            <text x={PAD.l - 8} y={y(value) + 3.5} textAnchor="end" className="tick">{value}</text>
          </g>
        ))}

        {stacked.map((band) => (
          <path
            key={band.name}
            d={band.d}
            fill={band.slot}
            fillOpacity={muted && muted !== band.name ? 0.12 : 0.82}
            stroke={band.slot}
            strokeWidth={0.75}
            strokeOpacity={muted && muted !== band.name ? 0.2 : 0.9}
          />
        ))}

        {hover !== null && (
          <line
            x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={PAD.t + plot.h}
            className="cursor-line"
          />
        )}

        {topics.map((point, i) =>
          // Only label a few buckets, or the axis turns into a smear.
          i % Math.max(1, Math.round(topics.length / 6)) === 0 ? (
            <text key={point.bucket} x={x(i)} y={H - 8} textAnchor="middle" className="tick">
              {fmtBucket(point.bucket, grain)}
            </text>
          ) : null,
        )}
      </svg>

      <div className="topic-key">
        {model.names.map((name, layer) => (
          <button
            key={name}
            className="topic-key-item"
            aria-pressed={muted === name}
            onPointerEnter={() => setMuted(name)}
            onPointerLeave={() => setMuted(null)}
            onClick={() => setMuted((current) => (current === name ? null : name))}
          >
            <span className="topic-swatch" style={{ background: SLOTS[layer % SLOTS.length] }} />
            <span className="topic-name">{name}</span>
            <span className="topic-total">{model.totals.get(name)}</span>
          </button>
        ))}
      </div>

      {tip.node}
    </div>
  );
}
