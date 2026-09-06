import { useMemo, useRef, useState } from 'react';
import type { BuzzPoint, Issue } from '../../../shared/types.ts';
import { fmtBucket, fmtDate, fmtScore, grainOf } from '../lib.ts';
import { useTooltip } from './tooltip.tsx';

/** The tape: sentiment drawn as a continuous trace on ruled recorder paper,
 *  with incidents punched in as pins above the line.
 *
 *  Sentiment is a polarity, so it gets the diverging encoding — one hue each
 *  side of a neutral zero rule, never a single ramp. The trace itself stays ink
 *  so the fill carries the sign and the line carries the shape.
 */
export function Tape({
  buzz, issues, onScrub, cursor,
}: {
  buzz: BuzzPoint[];
  issues: Issue[];
  cursor: string | null;
  onScrub: (bucket: string | null) => void;
}) {
  const W = 1000, H = 190, PAD = { t: 22, r: 12, b: 26, l: 40 };
  const svgRef = useRef<SVGSVGElement>(null);
  // Read from the buckets themselves — days, weeks or months depending on
  // what the scan actually covered.
  const grain = grainOf(buzz.map((p) => p.bucket));
  const [hover, setHover] = useState<number | null>(null);
  const tip = useTooltip();

  const plot = { w: W - PAD.l - PAD.r, h: H - PAD.t - PAD.b };
  const x = (i: number) => PAD.l + (buzz.length < 2 ? plot.w / 2 : (i / (buzz.length - 1)) * plot.w);
  const y = (score: number) => PAD.t + ((1 - score) / 2) * plot.h;

  const path = useMemo(() => buzz.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.score)}`).join(' '), [buzz]);

  // Two clipped copies of the same area: one above the zero rule, one below, so
  // each side reads in its own pole colour without a gradient.
  const area = `${path} L${x(buzz.length - 1)},${y(0)} L${x(0)},${y(0)} Z`;

  const pins = useMemo(() => {
    if (buzz.length === 0) return [];
    return issues
      .filter((issue) => issue.firstSeen)
      .map((issue) => {
        const bucket = issue.firstSeen!.slice(0, 7);
        const index = buzz.findIndex((p) => p.bucket.startsWith(bucket));
        return index === -1 ? null : { issue, index };
      })
      .filter((p): p is { issue: Issue; index: number } => p !== null);
  }, [issues, buzz]);

  if (buzz.length === 0) {
    return (
      <div className="empty">
        <h3>The pen hasn't moved</h3>
        <p>No dated discussion came back, so there is no trace to draw. Undated mentions still appear in the ledger below.</p>
      </div>
    );
  }

  const nearest = (event: React.PointerEvent) => {
    const box = svgRef.current!.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * W;
    let best = 0;
    for (let i = 1; i < buzz.length; i++) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
    return best;
  };

  return (
    <div className="tape-body">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Sentiment trace across ${buzz.length} ${grain === 'month' ? 'months' : grain === 'week' ? 'weeks' : 'days'}, from ${fmtBucket(buzz[0].bucket, grain)} to ${fmtBucket(buzz.at(-1)!.bucket, grain)}`}
        onPointerMove={(event) => {
          const index = nearest(event);
          setHover(index);
          const point = buzz[index];
          tip.show(
            event,
            <>
              <div className="k">{fmtBucket(point.bucket, grain)}</div>
              <div>
                <span className="v">{fmtScore(point.score)}</span> mean sentiment
              </div>
              <div>{point.volume} {point.volume === 1 ? 'mention' : 'mentions'}</div>
            </>,
          );
        }}
        onPointerLeave={() => { setHover(null); tip.hide(); }}
        onClick={() => onScrub(hover === null ? null : buzz[hover].bucket === cursor ? null : buzz[hover].bucket)}
        style={{ cursor: 'crosshair' }}
      >
        <defs>
          <clipPath id="tape-above"><rect x={0} y={PAD.t} width={W} height={y(0) - PAD.t} /></clipPath>
          <clipPath id="tape-below"><rect x={0} y={y(0)} width={W} height={PAD.t + plot.h - y(0)} /></clipPath>
        </defs>

        {[1, 0.5, -0.5, -1].map((v) => (
          <line key={v} className="gridline" x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} />
        ))}
        {[1, 0, -1].map((v) => (
          <text key={v} className="tick" x={PAD.l - 8} y={y(v) + 3.5} textAnchor="end">
            {v > 0 ? '+1' : v < 0 ? '−1' : '0'}
          </text>
        ))}

        {/* The zero rule is the one line that matters; it sits above the grid. */}
        <line className="axisline" x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} strokeWidth={1.5} />

        <path d={area} fill="var(--pos)" opacity={0.16} clipPath="url(#tape-above)" />
        <path d={area} fill="var(--neg)" opacity={0.16} clipPath="url(#tape-below)" />
        <path d={path} fill="none" stroke="var(--ink)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

        {buzz.map((point, i) => (
          <circle
            key={point.bucket}
            cx={x(i)} cy={y(point.score)} r={hover === i ? 5.5 : 4}
            fill={point.score >= 0 ? 'var(--pos)' : 'var(--neg)'}
            stroke="var(--paper)" strokeWidth={2}
          />
        ))}

        {pins.map(({ issue, index }) => (
          <g
            key={issue.id}
            onPointerEnter={(event) =>
              tip.show(event, (
                <>
                  <div className="k">Incident · {issue.severity}</div>
                  <div className="v">{issue.title}</div>
                  <div>First reported {fmtDate(issue.firstSeen)}</div>
                </>
              ))
            }
          >
            <line className="pin-stem" x1={x(index)} x2={x(index)} y1={PAD.t - 14} y2={y(buzz[index].score)} />
            <rect x={x(index) - 4} y={PAD.t - 20} width={8} height={8} rx={1.5} fill="var(--pen)" />
          </g>
        ))}

        {cursor && (() => {
          const index = buzz.findIndex((p) => p.bucket === cursor);
          return index === -1 ? null : (
            <line className="cursor-line" x1={x(index)} x2={x(index)} y1={PAD.t - 20} y2={PAD.t + plot.h} />
          );
        })()}

        {buzz.map((point, i) =>
          // Label the ends and every third bucket; a tick under every point is noise.
          i === 0 || i === buzz.length - 1 || i % 3 === 0 ? (
            <text key={point.bucket} className="tick" x={x(i)} y={H - 8} textAnchor="middle">
              {fmtBucket(point.bucket, grain)}
            </text>
          ) : null,
        )}
      </svg>
      {tip.node}
    </div>
  );
}
