import { useCallback, useEffect, useState } from 'react';
import type { Stage } from '../../../shared/types.ts';
import { STAGES } from '../../../shared/types.ts';
import { api, fmtAgo } from '../lib.ts';

interface Job {
  id: string;
  scanId: string;
  company: string;
  stages: Stage[];
  options: { depth?: string; languages?: string[]; dig?: string };
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  stage?: Stage;
}

const label = (stage: Stage) => STAGES.find((s) => s.key === stage)?.label ?? stage;

const what = (job: Job) =>
  (job.stages.length ? job.stages.map(label).join(' → ') : 'Full scan');

/** What is running, what is waiting, and what happened to the rest.
 *
 *  Work is serialised — one search budget, one set of provider pacers, one
 *  inference endpoint — so asking for something while another run is going puts
 *  it in line rather than refusing it. That only helps if the line is visible:
 *  a job that starts in four minutes and a job that silently never started look
 *  identical from the outside, and the second used to be what happened.
 */
export function QueuePanel({ onClose, onOpenScan }: {
  onClose?: () => void;
  onOpenScan: (scanId: string) => void;
}) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [waiting, setWaiting] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ jobs: Job[]; waiting: number }>('api/jobs')
      .then((data) => { setJobs(data.jobs); setWaiting(data.waiting); })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    load();
    // The queue moves on its own — a job finishing starts the next one — so
    // this has to poll rather than render once.
    const timer = setInterval(load, 4_000);
    return () => clearInterval(timer);
  }, [load]);

  const cancel = async (id: string) => {
    try {
      const data = await api<{ jobs: Job[]; waiting: number }>(`api/jobs/${id}`, { method: 'DELETE' });
      setJobs(data.jobs);
      setWaiting(data.waiting);
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, '').slice(0, 200));
    }
  };

  const running = (jobs ?? []).filter((job) => job.state === 'running');
  const queued = (jobs ?? []).filter((job) => job.state === 'queued');
  const past = (jobs ?? []).filter((job) => !['running', 'queued'].includes(job.state));

  return (
    <section className="card-stack">
      {onClose && <button className="ghost back-to-scans" onClick={onClose}>← Back to scans</button>}

      <div className="rubric">
        <h2>Queue</h2>
      </div>

      {error && <div className="set-message err" style={{ padding: '12px 16px' }}>{error}</div>}
      {!jobs && !error && <div className="set-loading">Loading…</div>}

      {jobs && (
        <div className="panel">
          <div className="set-head">
            <strong>Now</strong>
            <span className="tag plain">
              {running.length ? '1 running' : 'idle'}{waiting ? ` · ${waiting} waiting` : ''}
            </span>
          </div>

          <div className="conn-list">
            {running.map((job) => (
              <div className="conn-row" key={job.id}>
                <span className="conn-dot" data-run="running" />
                <button className="conn-name conn-link" onClick={() => onOpenScan(job.scanId)}>
                  {job.company}
                </button>
                <span className="conn-meta">{what(job)}</span>
                <span className="conn-meta">
                  {job.stage ? `on ${label(job.stage)}` : ''}
                  {job.startedAt ? ` · ${fmtAgo(job.startedAt)}` : ''}
                </span>
              </div>
            ))}

            {queued.map((job, i) => (
              <div className="conn-row" key={job.id}>
                <span className="conn-dot" data-run="idle" />
                <button className="conn-name conn-link" onClick={() => onOpenScan(job.scanId)}>
                  {job.company}
                </button>
                <span className="conn-meta">{what(job)}</span>
                <span className="conn-meta">
                  {/* Where it is in line, which is the only thing somebody
                      waiting actually wants to know. */}
                  #{i + 1} in line · asked {fmtAgo(job.queuedAt)}
                  {job.options.depth === 'deep' ? ' · deep' : ''}
                  {job.options.dig ? ` · digging ${job.options.dig}` : ''}
                </span>
                <button className="ghost" onClick={() => cancel(job.id)}>remove</button>
              </div>
            ))}

            {running.length === 0 && queued.length === 0 && (
              <div className="conn-row"><span className="q">Nothing running and nothing waiting.</span></div>
            )}
          </div>
        </div>
      )}

      {past.length > 0 && (
        <div className="panel">
          <div className="set-head">
            <strong>Finished</strong>
            <span className="tag plain">{past.length}</span>
          </div>
          <div className="conn-list">
            {past.map((job) => (
              <div className="conn-row" key={job.id}>
                <span className="conn-dot" data-run={job.state === 'done' ? 'ok' : 'failed'} />
                <button className="conn-name conn-link" onClick={() => onOpenScan(job.scanId)}>
                  {job.company}
                </button>
                <span className="conn-meta">{what(job)}</span>
                <span className="conn-meta">
                  {job.state}
                  {job.finishedAt ? ` · ${fmtAgo(job.finishedAt)}` : ''}
                </span>
                {job.error && <span className="conn-err">{job.error}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
