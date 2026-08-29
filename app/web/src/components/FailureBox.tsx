import { useState } from 'react';
import { STAGES, type Stage } from '../../../shared/types.ts';

/** A run (or a single step of it) failed. Explain it in plain language, let the
 *  user retry just that step, and tuck the raw error behind a details toggle. */
export function FailureBox({
  stage,
  message,
  detail,
  running,
  onRetry,
}: {
  stage?: Stage;
  message: string;
  detail?: string;
  running: boolean;
  onRetry: () => void;
}) {
  const [open, setOpen] = useState(false);
  const label = stage ? (STAGES.find((s) => s.key === stage)?.label ?? stage) : 'pipeline';

  return (
    <div className="panel fail">
      <div className="fail-head">
        <span className="tag critical">Failed</span>
        <h3>{stage ? `${label} didn't finish` : "This scan didn't finish"}</h3>
        {stage && (
          <button className="rerun primary-rerun" onClick={onRetry} disabled={running}>
            {running ? 'Retrying…' : '↻ Retry this step'}
          </button>
        )}
      </div>
      <p className="fail-why">{message}</p>
      {detail && (
        <div className="fail-more">
          <button className="fail-toggle" onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide' : 'Show'} the technical detail
          </button>
          {open && <pre className="fail-detail">{detail}</pre>}
        </div>
      )}
    </div>
  );
}
