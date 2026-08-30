import { useCallback, useState } from 'react';
import { STAGES, type Stage } from '../../../shared/types.ts';
import { api } from '../lib.ts';

type ErrorKind = 'connector' | 'model' | 'rate' | 'timeout' | 'auth' | 'other';

interface ConnectorStatus {
  name: string;
  status: 'ok' | 'needs-auth' | 'down';
  authStatus?: string;
  tools: number;
  error?: string;
}

/** A run (or a single step of it) failed. Explain it in plain language, offer a
 *  corrective action where one exists (reconnect connectors), let the user retry
 *  the failed step, and tuck the raw error behind a details toggle. */
export function FailureBox({
  stage,
  message,
  detail,
  kind,
  running,
  onRetry,
  onRerunAll,
}: {
  stage?: Stage;
  message: string;
  detail?: string;
  kind?: ErrorKind;
  running: boolean;
  onRetry: () => void;
  onRerunAll: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [connectors, setConnectors] = useState<ConnectorStatus[] | null>(null);
  const [checking, setChecking] = useState(false);

  const label = stage ? (STAGES.find((s) => s.key === stage)?.label ?? stage) : 'pipeline';
  const hasConnectorRemedy = kind === 'connector' || kind === 'auth';

  const check = useCallback(async (reconnect: boolean) => {
    setChecking(true);
    try {
      const data = await api<ConnectorStatus[]>(
        reconnect ? '/api/connectors/reconnect' : '/api/connectors',
        reconnect ? { method: 'POST' } : undefined,
      );
      setConnectors(data);
    } catch (error) {
      setConnectors([{ name: '(list failed)', status: 'down', tools: 0, error: String(error) }]);
    } finally {
      setChecking(false);
    }
  }, []);

  const bad = connectors?.filter((c) => c.status !== 'ok').length ?? 0;

  return (
    <div className="panel fail">
      <div className="fail-head">
        <span className="tag critical">Failed</span>
        <h3>{stage ? `${label} didn't finish` : "This scan didn't finish"}</h3>
        <div className="fail-actions">
          <button className="rerun primary-rerun" onClick={onRerunAll} disabled={running || checking}>
            {running ? 'Rerunning…' : '↻ Rerun scan'}
          </button>
          {stage && (
            <button className="rerun" onClick={onRetry} disabled={running || checking}>
              {running ? 'Retrying…' : '↻ Retry this step'}
            </button>
          )}
        </div>
      </div>
      <p className="fail-why">{message}</p>

      <div className="fail-next">
        <span className="next-title">What to do</span>
        <ol>
          <li>Hit <b>Rerun scan</b> — most failures here are transient and clear on a clean retry.</li>
          {stage && <li>Prefer <b>Retry this step</b> to redo only the {label.toLowerCase()} step, if the rest of the scan looked good.</li>}
          {kind === 'connector' || kind === 'auth' ? (
            <li>Check the connectors below — one isn't reachable, so reconnect or re-authorize it before retrying.</li>
          ) : kind === 'rate' ? (
            <li>Likely a rate limit — wait a few seconds, then retry.</li>
          ) : kind === 'timeout' ? (
            <li>A backend was too slow to answer — retry, or run at a quieter time.</li>
          ) : kind === 'model' ? (
            <li>The model returned unusable output — retry once; if it keeps failing, switch to a stronger model.</li>
          ) : null}
          <li>If nothing starts at all, the API server may be down — make sure it is running, then retry.</li>
        </ol>
      </div>

      {hasConnectorRemedy && (
        <div className="fail-fix">
          <div className="fix-row">
            <span className="fix-title">Check the connectors</span>
            <span className="fix-why">The step above needed a search connector that isn't responding.</span>
            {connectors === null ? (
              <button className="rerun" onClick={() => check(false)} disabled={checking}>
                {checking ? 'Checking…' : 'Check connectors'}
              </button>
            ) : (
              <>
                <button className="rerun" onClick={() => check(true)} disabled={checking}>
                  {checking ? 'Reconnecting…' : '↻ Reconnect & re-check'}
                </button>
                {bad === 0 && <span className="fix-done">All connectors are responding — hit retry above.</span>}
                {bad > 0 && (
                  <span className="fix-bad">
                    {bad} problem{bad === 1 ? '' : 's'} need attention — reconnect, or set the missing credentials and re-run <code>npm run setup</code>.
                  </span>
                )}
              </>
            )}
          </div>
          {connectors && (
            <div className="fix-list">
              {connectors.map((c) => (
                <div key={c.name} className={`fix-item s-${c.status}`}>
                  <span className="fix-dot" />
                  <span className="fix-name">{c.name}</span>
                  <span className="fix-status">
                    {c.status === 'ok'
                      ? `${c.tools} tools ready`
                      : c.status === 'needs-auth'
                        ? 'needs credentials'
                        : c.error ?? 'unreachable'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

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
