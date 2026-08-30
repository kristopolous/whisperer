import type { Scan, Stage } from '../../../shared/types.ts';
import { cleanName, fmtMonth } from '../lib.ts';

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

/** The bare hostname of a site, for its favicon. Falls back to a rough scrape if
 *  the stored value isn't a parseable URL. */
const hostOf = (site: string): string => {
  try {
    return new URL(site).hostname.replace(/^www\./, '');
  } catch {
    return (site || '').replace(/^https?:\/\//, '').split('/')[0].split(':')[0].replace(/^www\./, '');
  }
};

/** Left rail of the dashboard: a "new site" action on top and the full-height
 *  list of every site that has been scanned, newest first. Clicking a site
 *  pulls that run's tabs into the main canvas. */
export function RunDashboard({
  runs,
  activeId,
  onOpen,
  onNew,
}: {
  runs: RunSummary[];
  activeId: string;
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <aside className="dash-rail">
      <div className="dash-rail-top">
        <button className="new-site" onClick={onNew}>
          <span className="plus">+</span> New site
        </button>
      </div>
      <div className="dash-sites-head">
        <span>Scanned sites</span>
        <span className="count">{runs.length}</span>
      </div>
      <div className="dash-sites">
        {runs.length === 0 && <div className="dash-empty">No scans yet</div>}
        {runs.map((run) => (
          <button
            key={run.id}
            className="dash-site"
            aria-current={run.id === activeId}
            onClick={() => onOpen(run.id)}
          >
            <span className="t">
              <img
                className="favicon"
                src={`https://www.google.com/s2/favicons?domain=${hostOf(run.site)}&sz=64`}
                alt=""
                loading="lazy"
                onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
              />
              <span className="t-name">{cleanName(run.company)}</span>
              <span className={`st-dot ${run.status === 'done' ? 'ok' : run.status === 'error' ? 'bad' : 'warn'}`} />
            </span>
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
    </aside>
  );
}
