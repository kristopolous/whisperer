import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Every chart here is hoverable; this is the shared plumbing.
 *  Rendered in a portal so an SVG's overflow never clips it. */
export function useTooltip() {
  const [tip, setTip] = useState<{ x: number; y: number; body: ReactNode } | null>(null);

  const show = (event: { clientX: number; clientY: number }, body: ReactNode) =>
    setTip({ x: event.clientX, y: event.clientY, body });
  const hide = () => setTip(null);

  const node =
    tip &&
    createPortal(
      <div
        className="tip"
        role="tooltip"
        style={{
          // Flip to the left near the right edge so the tip never runs off-screen.
          left: tip.x > window.innerWidth - 330 ? undefined : tip.x + 14,
          right: tip.x > window.innerWidth - 330 ? window.innerWidth - tip.x + 14 : undefined,
          top: Math.min(tip.y + 14, window.innerHeight - 160),
        }}
      >
        {tip.body}
      </div>,
      document.body,
    );

  return { show, hide, node };
}
