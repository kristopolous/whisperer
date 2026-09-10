import type { Mention } from '../../../shared/types.ts';
import { counts, venueOf } from '../lib.ts';
import { useTooltip } from './tooltip.tsx';

/** Where the conversation happens. Magnitude by venue, so: bars, sorted, with the
 *  value written on each — the light-mode series steps sit under 3:1 against the
 *  paper, and a visible label is what makes that legal. */
export function VenueBars({ mentions }: { mentions: Mention[] }) {
  const rows = counts(mentions);
  const tip = useTooltip();
  if (rows.length === 0) return null;

  const max = Math.max(...rows.map(([, n]) => n));
  const ROW = 30, LABEL = 96, VALUE = 34, W = 460;
  const track = W - LABEL - VALUE;

  return (
    <div className="viz">
      {/* Drawn at its own size, not stretched to the panel.
          A `viewBox` with no width or height scales to the container, and
          everything inside scales with it — including the labels, which then
          render at nearly twice the size of every other word on the page in a
          wide panel. The chart is 460 units wide because that is how wide it
          was designed to be; `.viz` scrolls if the panel is narrower. */}
      <svg
        viewBox={`0 0 ${W} ${rows.length * ROW + 6}`}
        width={W}
        height={rows.length * ROW + 6}
        role="img"
        aria-label="Mentions by venue"
      >
        {rows.map(([venue, n], i) => {
          const meta = venueOf(venue);
          const width = Math.max(3, (n / max) * track);
          const y = i * ROW + 3;
          return (
            <g
              key={venue}
              onPointerMove={(event) =>
                tip.show(event, (
                  <>
                    <div className="k">{meta.label}</div>
                    <div><span className="v">{n}</span> of {mentions.length} mentions</div>
                  </>
                ))
              }
              onPointerLeave={tip.hide}
            >
              <text className="mark-label" x={LABEL - 10} y={y + 15} textAnchor="end">{meta.label}</text>
              {/* 4px rounded end, anchored square to the baseline. */}
              <path
                d={`M${LABEL},${y + 4} h${width - 4} a4,4 0 0 1 4,4 v6 a4,4 0 0 1 -4,4 h-${width - 4} z`}
                fill={meta.slot}
              />
              <text className="mark-label" x={LABEL + width + 8} y={y + 15} style={{ fill: 'var(--ink)' }}>{n}</text>
            </g>
          );
        })}
      </svg>
      {tip.node}
    </div>
  );
}
