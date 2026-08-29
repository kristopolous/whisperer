import type { Scan, Stage } from '../../../shared/types.ts';
import { fmtMonth } from '../lib.ts';

/** A past run as served by GET /api/scans — mentions/issues stripped to counts. */
export interface RunSummary {
  id: string;
  company: string;
  site: string;
  createdAt: string;
  status: Scan['status'];
  stage: Scan['stage'];
  error?: string;
  counts: { mentions: number; issues: number };
  net: { now: number; delta: number };
  verdict: string;
  sessionId?: string;
}

const STAGE_KEYS: Stage[] = ['presence', 'discovery', 'buzz', 'health', 'abuse'];

const fmtScore = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(2);
const cleanSite = (site: string) => (site ? site.replace(/^https?:\/\//, '') : '');

function StageStrip({ stage, failedStage, status }: { stage: Stage; failedStage?: Stage; status: Scan['status'] }) {
  return (
    <div className="dash-stages" title={`Progress — ${status}`}>
      {STAGE_KEYS.map((key) => {
        const idx = STAGE_KEYS.indexOf(key);
        const done = idx < STAGE_KEYS.indexOf(stage) || status === 'done';
        const failed = key === failedStage;
        const active = key === stage;
        return (
          <span
            key={key}
            data-state={failed ? 'failed' : active ? 'active' : done ? 'done' : 'idle'}
            title={key}
            className="d-step"
          >
            <i />
          </span>
        );
      })}
    </div>
  );
}

/** Left rail of the dashboard: an overall summary card, the status of the run
 *  currently in view, and a list of every site that has been scanned. */
export function RunDashboard({
  runs,
  scan,
  onOpen,
}: {
  runs: RunSummary[];
  scan: Scan;
  onOpen: (id: string) => void;
}) {
  const hasActive = !!scan.id;
  const good = runs.filter((r) => r.status === 'done').length;
  const failed = runs.filter((r) => r.status === 'error').length;

  return (
    <aside className="dash-rail">
      <div className="dash-card dash-summary">
        <h3>Dashboard</h3>
        <dl>
          <div><dt>Scans</dt><dd>{runs.length}</dd></div>
          <div><dt>Healthy</dt><dd className="pos">{good}</dd></div>
          <div><dt>Failed</dt><dd className={failed ? 'neg' : ''}>{failed}</dd></div>
        </dl>
      </div>

      {hasActive && (
        <div className={`dash-card dash-active ${scan.status === 'error' ? 'bad' : ''}`}>
          <h3>
            {scan.company || 'Current run'}
            <span className={`tag ${scan.status === 'done' ? 'good' : scan.status === 'error' ? 'critical' : 'warning'}`}>
              {scan.status}
            </span>
          </h3>
          {scan.site && <span className="dash-site-url">{cleanSite(scan.site)}</span>}
          <StageStrip stage={scan.stage} failedStage={scan.failedStage} status={scan.status} />
          {scan.error && <p className="dash-err">{scan.error}</p>}
        </div>
      )}

      <div className="dash-card dash-sitelist">
        <h3>
          Scanned sites
          <span className="count">{runs.length}</span>
        </h3>
        <div className="dash-sites">
          {runs.map((run) => (
            <button
              key={run.id}
              className="dash-site"
              aria-current={run.id === scan.id}
              onClick={() => onOpen(run.id)}
            >
              <span className="t">{run.company}</span>
              <span className="s">{cleanSite(run.site) || fmtMonth(run.createdAt)}</span>
              <span className="m">
                <span className={`l-arr ${run.net.now >= 0 ? 'up' : 'down'}`}>
                  {fmtScore(run.net.now)}
                </span>
                <span className="c">{run.counts.issues} issues</span>
                <span className={`tag ${run.status === 'done' ? 'good' : run.status === 'error' ? 'critical' : 'warning'}`}>
                  {run.status}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
