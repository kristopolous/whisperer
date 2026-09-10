import { useState } from 'react';
import type { Scan, Stage } from '../../../shared/types.ts';
import { cleanName, fmtAgo, fmtMonth } from '../lib.ts';

/** A past run as served by GET /api/scans — mentions/issues stripped to counts. */
export interface RunSummary {
  id: string;
  company: string;
  site: string;
  createdAt: string;
  /** When the work currently on this record began, and when each stage last
   *  finished. The rail reads these rather than `createdAt`, which is when the
   *  row first appeared and never moves again. */
  startedAt?: string;
  pulledAt?: Partial<Record<Scan['stage'], string>>;
  status: Scan['status'];
  stage: Scan['stage'];
  error?: string;
  counts: { mentions: number; issues: number; scored?: number };
  net: { now: number; delta: number };
  verdict: string;
  sessionId?: string;
  fixture?: boolean;
}

const STAGE_KEYS: Stage[] = ['presence', 'discovery', 'buzz', 'health', 'abuse'];

/** When this company was last actually looked at.
 *
 *  Not `createdAt`, which is when the record was minted and never moves again —
 *  so a company scanned an hour ago still read "4d" because that is when the row
 *  first appeared. The rail is asked "which of these is stale", and a stage
 *  rerun is the commonest way something stops being stale.
 *
 *  The latest of: this run's start, and the last time any stage finished. */
function lastRunAt(run: { createdAt: string; startedAt?: string; pulledAt?: Record<string, string | undefined> }): string {
  const stamps = [
    run.createdAt,
    run.startedAt,
    ...Object.values(run.pulledAt ?? {}),
  ].filter((at): at is string => Boolean(at));
  return stamps.sort().at(-1) ?? run.createdAt;
}

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
  onRemove,
}: {
  runs: RunSummary[];
  activeId: string;
  onOpen: (id: string) => void;
  onNew: () => void;
  onRemove: (id: string) => Promise<void> | void;
}) {
  // Deleting is not undoable, so it asks first. Held as the pending run rather
  // than a boolean so the dialog can name what is about to go.
  const [pending, setPending] = useState<RunSummary | null>(null);
  const [removing, setRemoving] = useState(false);

  const confirm = async () => {
    if (!pending) return;
    setRemoving(true);
    try {
      await onRemove(pending.id);
      setPending(null);
    } finally {
      setRemoving(false);
    }
  };

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
              {run.fixture && <span className="tag plain" style={{ fontSize: 9.5 }}>demo</span>}
              <span className={`st-dot ${run.status === 'done' ? 'ok' : run.status === 'error' ? 'bad' : 'warn'}`} />
            </span>
            <span className="s">
              <span className="s-url">{cleanSite(run.site) || fmtMonth(run.createdAt)}</span>
              <span
                className="site-remove"
                role="button"
                tabIndex={0}
                title={`Remove ${cleanName(run.company)}`}
                aria-label={`Remove ${cleanName(run.company)}`}
                onClick={(event) => { event.stopPropagation(); setPending(run); }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    event.stopPropagation();
                    setPending(run);
                  }
                }}
              >
                ×
              </span>
            </span>
            <span className="m">
              {/* An em dash rather than +0.00 when nothing was scored — the
                  difference between neutral opinion and no opinion read. */}
              <span className={`l-arr ${run.counts.scored ? (run.net.now >= 0 ? 'up' : 'down') : ''}`}>
                {run.counts.scored ? fmtScore(run.net.now) : '—'}
              </span>
              <span className="c">{run.counts.issues} issues</span>
              {/* Age, not "done".
                  A run that finished says nothing useful by saying so — every
                  row in a working install says "done" and the word is the same
                  on a scan from an hour ago and one from a fortnight ago. What
                  the rail is actually asked is "which of these is stale", and
                  only the age answers it. The other states keep their word,
                  because "running" and "error" are not about time. */}
              <span
                className={`tag ${run.status === 'done' ? 'plain' : run.status === 'error' ? 'critical' : 'warning'}`}
                title={new Date(run.createdAt).toLocaleString()}
              >
                {run.status === 'done' ? (fmtAgo(lastRunAt(run)) ?? 'done') : run.status}
              </span>
            </span>
          </button>
        ))}
      </div>

      {pending && (
        <div
          className="lightbox"
          role="dialog"
          aria-modal="true"
          aria-labelledby="remove-title"
          onClick={() => !removing && setPending(null)}
        >
          <div className="lightbox-card" onClick={(event) => event.stopPropagation()}>
            <h3 id="remove-title">Remove {cleanName(pending.company)}?</h3>
            <p>
              This deletes every scan of {cleanName(pending.company)} — the mentions, issues and
              history behind this row. It cannot be undone.
            </p>
            <div className="lightbox-actions">
              <button className="ghost" onClick={() => setPending(null)} disabled={removing}>
                Cancel
              </button>
              <button className="danger" onClick={confirm} disabled={removing}>
                {removing ? 'Removing…' : 'Remove'}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
