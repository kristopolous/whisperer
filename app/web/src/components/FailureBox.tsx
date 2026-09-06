import { useCallback, useEffect, useRef, useState } from 'react';
import { STAGES, type ErrorKind, type Scan, type Stage } from '../../../shared/types.ts';
import { api } from '../lib.ts';

interface ConnectorStatus {
  name: string;
  status: 'ok' | 'needs-auth' | 'down';
  authStatus?: string;
  tools: number;
  error?: string;
}

/** What the run that refused this one is actually doing.
 *
 *  The run's own log, not a summary of it. A one-line digest could say
 *  "Discovery, 4 minutes" and still leave the only question that matters —
 *  is it moving? — unanswered; the log answers it by scrolling. It is also the
 *  same thing the live run shows, so watching a run somebody else started looks
 *  like watching your own.
 *
 *  Polled rather than streamed: the event stream belongs to whoever started the
 *  run, and this is by definition the other caller. The scan record is written
 *  at every stage boundary, so the log is on disk and only had to be read.
 */
function BusyProgress({ scanId, onStop, stopping }: {
  scanId: string;
  onStop?: () => void;
  stopping?: boolean;
}) {
  const [scan, setScan] = useState<Scan | null>(null);
  const [now, setNow] = useState(Date.now());
  const tail = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    const read = () => {
      api<Scan>(`api/scans/${scanId}`)
        .then((data) => { if (live) setScan(data); })
        .catch(() => {});
    };
    read();
    const poll = setInterval(read, 4_000);
    // The clock ticks on its own so it moves every second rather than jumping
    // in four-second steps — a clock that stutters reads as a stalled run.
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => { live = false; clearInterval(poll); clearInterval(tick); };
  }, [scanId]);

  useEffect(() => { tail.current?.scrollTo({ top: 1e6 }); }, [scan?.log?.length]);

  if (!scan) return null;
  if (scan.status !== 'running') {
    // The status alone said "FINISHED — ERROR" and stopped there, which names
    // the outcome and withholds the only part that is any use. The scan carries
    // the message and the stage that produced it; both go on screen.
    const failed = scan.status === 'error';
    return (
      <div className={`notice${failed ? '' : ' ok'}`}>
        <span className={`tag ${failed ? 'critical' : 'plain'}`}>finished — {scan.status}</span>
        {failed && scan.error && (
          <span>
            {scan.failedStage && <b>{STAGES.find((s) => s.key === scan.failedStage)?.label ?? scan.failedStage}: </b>}
            {scan.error}
          </span>
        )}
        {failed && scan.errorDetail && scan.errorDetail !== scan.error && (
          <details>
            <summary className="conn-meta">raw</summary>
            <pre className="log-raw">{scan.errorDetail}</pre>
          </details>
        )}
      </div>
    );
  }

  const log = scan.log ?? [];
  const label = STAGES.find((s) => s.key === scan.stage)?.label ?? scan.stage;
  // From the first line of THIS run. The record is created once and re-run for
  // months, so `createdAt` reported a three-minute scan as "2924 min in".
  const startedAt = log[0]?.at;
  const seconds = startedAt ? Math.max(0, Math.round((now - new Date(startedAt).getTime()) / 1000)) : 0;
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

  return (
    <>
      <div className="notice">
        <span className="tag warning">already running</span>
        <span className="busy-clock">{clock}</span>
        <span className="conn-meta">{label}</span>
        {onStop && (
          <button className="rerun" onClick={onStop} disabled={stopping}>
            {stopping ? 'Stopping…' : '■ Stop it'}
          </button>
        )}
      </div>
      {log.length > 0 && (
        <div className="busy-run">
          <div className="console" ref={tail}>
            {log.slice(-200).map((line, i) => (
              <div key={i} className={`log-line lvl-${line.level}`}>
                <span className="log-time">{line.at.slice(11, 19)}</span>
                <span className="log-stage">{line.stage}</span>
                {line.text}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/** A run (or a single step of it) failed. Explain it in plain language, offer a
 *  corrective action where one exists (reconnect connectors), let the user retry
 *  the failed step, and tuck the raw error behind a details toggle. */
export function FailureBox({
  scanId,
  stage,
  message,
  detail,
  kind,
  running,
  onRetry,
  onRerunAll,
  onStop,
  stopping,
}: {
  scanId?: string;
  stage?: Stage;
  message: string;
  detail?: string;
  kind?: ErrorKind;
  running: boolean;
  onRetry: () => void;
  onRerunAll: () => void;
  /** Offered on the busy notice — the run this refused to start on top of is
   *  the one the person wants gone. */
  onStop?: () => void;
  stopping?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [connectors, setConnectors] = useState<ConnectorStatus[] | null>(null);
  const [checking, setChecking] = useState(false);

  const label = stage ? (STAGES.find((s) => s.key === stage)?.label ?? stage) : 'pipeline';
  const hasConnectorRemedy = kind === 'connector' || kind === 'auth';

  // Being busy is not a failure, and dressing it as one is actively misleading:
  // it puts a red "didn't finish" header and a "most failures here are
  // transient, hit Rerun" instruction on top of a run that is working fine.
  // Following that advice is the one thing that cannot help — the second run is
  // refused for the same reason, so the box reappears and reads as a loop.
  if (kind === 'busy') {
    // No prose. The tag says what is happening and the clock says how long; the
    // paragraph that used to be here explained a situation the two of them
    // already describe.
    return (
      <div className="panel">
        {scanId
          ? <BusyProgress scanId={scanId} onStop={onStop} stopping={stopping} />
          : <div className="notice"><span className="tag warning">already running</span></div>}
      </div>
    );
  }

  const check = useCallback(async (reconnect: boolean) => {
    setChecking(true);
    try {
      const data = await api<ConnectorStatus[]>(
        reconnect ? 'api/connectors/reconnect' : 'api/connectors',
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
