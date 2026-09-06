import { useEffect, useState } from 'react';
import { api, apiUrl } from '../lib.ts';

/** Everything the server knows about one agent, including how its runs went. */
interface AgentRow {
  name: string;
  title: string;
  description: string;
  surface: 'stage' | 'loop' | 'utility';
  stage?: string;
  connectors: string[];
  effort: 'low' | 'medium' | 'high';
  inPipeline: boolean;
  needsTools: boolean;
  instructionChars: number;
  stats: {
    runs: number;
    failures: number;
    lastStatus?: 'running' | 'ok' | 'failed';
    lastAt?: string;
    lastError?: string;
    medianMs?: number;
  };
}

interface AgentRun {
  id: string;
  agent: string;
  title: string;
  scanId?: string;
  stage?: string;
  note?: string;
  startedAt: string;
  ms?: number;
  status: 'running' | 'ok' | 'failed';
  error?: string;
  promptChars: number;
  resultChars?: number;
  items?: number;
}

const SURFACE_LABEL: Record<AgentRow['surface'], string> = {
  stage: 'scan stage',
  loop: 'resolution loop',
  utility: 'fired by hand',
};

const fmtMs = (ms?: number) => (ms == null ? '—' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
const fmtChars = (chars: number) => (chars < 1500 ? `${chars} chars` : `${(chars / 1000).toFixed(1)}k chars`);

/** The agent list.
 *
 *  The reason this screen exists: an agent that has never run, one that ran and
 *  failed, and one that runs fine but takes ninety seconds all look identical
 *  from a dashboard panel that came back empty. Each row says which of those it
 *  is, and the run feed underneath shows them landing live.
 */
export function AgentsPanel({ onClose }: { onClose?: () => void }) {
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    api<AgentRow[]>('api/agents').then(setAgents).catch((e) => setError(String(e)));
    api<AgentRun[]>('api/agents/runs?limit=50').then(setRuns).catch(() => setRuns([]));

    // Live runs. Each event is one state transition, so a run shows up as
    // "running" and is then replaced in place when it settles.
    const stream = new EventSource(apiUrl('api/agents/stream'));
    stream.onmessage = (event) => {
      const run = JSON.parse(event.data) as AgentRun;
      setRuns((current) => [run, ...current.filter((r) => r.id !== run.id)].slice(0, 100));
      if (run.status !== 'running') api<AgentRow[]>('api/agents').then(setAgents).catch(() => {});
    };
    return () => stream.close();
  }, []);

  const pipeline = (agents ?? []).filter((a) => a.inPipeline);
  const saved = (agents ?? []).filter((a) => !a.inPipeline);

  return (
    <section className="card-stack">
      {onClose && (
        <button className="ghost back-to-scans" onClick={onClose}>← Back to scans</button>
      )}
      <div className="rubric">
        <h2>Agents</h2>
        <p>
          Every agent is defined in <code>app/server/agents/</code> as plain data — instructions, output
          schema, connectors — and run from here directly. The same definitions export to TrueForge with{' '}
          <code>npm run setup</code>, so going back to a platform is a command, not a rewrite.
        </p>
      </div>

      {error && <div className="set-message err" style={{ padding: '12px 16px' }}>{error}</div>}
      {!agents && !error && <div className="set-loading">Loading agents…</div>}

      {agents && (
        <>
          <AgentGroup
            title="In the pipeline"
            badge="fired by a scan"
            hint="These run automatically, in stage order, every time a scan goes."
            rows={pipeline}
            open={open}
            onToggle={(name) => setOpen(open === name ? null : name)}
          />
          <AgentGroup
            title="Saved, not in the pipeline"
            badge="on demand"
            hint={
              'Kept because they are worth firing by hand. The retrieval they used to do is done '
              + 'deterministically now, so zero runs here is expected rather than a failure.'
            }
            rows={saved}
            open={open}
            onToggle={(name) => setOpen(open === name ? null : name)}
          />
        </>
      )}

      <div className="panel">
        <div className="set-head">
          <strong>Recent runs</strong>
          <span className="tag plain">live</span>
        </div>
        <p className="set-desc">
          Every model call in the app, as it happens — which agent, what it was given, how long it took,
          and the failure in its own words when there was one.
        </p>
        {runs.length === 0 ? (
          <div className="set-desc">
            No agent has run yet in this process. Start a scan and this fills in as each stage fires.
          </div>
        ) : (
          <div className="conn-list">
            {runs.map((run) => (
              <div key={run.id} className="conn-row run-row">
                <span className="conn-dot" data-run={run.status} />
                <span className="conn-name">
                  {run.title}
                  {run.note && <span className="run-note"> · {run.note}</span>}
                </span>
                <span className="conn-meta">
                  {run.items != null ? `${run.items} items · ` : ''}
                  {fmtChars(run.promptChars)} in
                  {run.resultChars != null ? ` · ${fmtChars(run.resultChars)} out` : ''}
                </span>
                <span className="conn-meta">{run.status === 'running' ? 'running…' : fmtMs(run.ms)}</span>
                {run.error && <span className="conn-err">{run.error}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function AgentGroup(
  { title, badge, hint, rows, open, onToggle }:
  { title: string; badge: string; hint: string; rows: AgentRow[]; open: string | null; onToggle: (name: string) => void },
) {
  if (rows.length === 0) return null;

  return (
    <div className="panel">
      <div className="set-head">
        <strong>{title}</strong>
        <span className="tag plain">{badge}</span>
      </div>
      <p className="set-desc">{hint}</p>
      <div className="conn-list">
        {rows.map((agent) => {
          const { stats } = agent;
          // "never run" is its own state and must not read as green.
          const dot = stats.runs === 0 ? 'idle' : stats.lastStatus ?? 'idle';
          // ...and it is not the same state as "nothing calls this". An agent
          // kept in the registry that no code path fires has not failed to run;
          // it is not wired in, and saying "never run" about it invites a hunt
          // for a broken trigger that does not exist.
          const unwired = stats.runs === 0 && !agent.inPipeline;
          return (
            <div key={agent.name}>
              <button className="conn-row agent-row" onClick={() => onToggle(agent.name)}>
                <span className="conn-dot" data-run={dot} />
                <span className="conn-name">
                  {agent.title}
                  <span className="agent-desc"> — {agent.description}</span>
                </span>
                <span className="conn-meta">
                  {stats.runs === 0
                    ? (agent.needsTools ? 'cannot run here' : unwired ? 'not wired into a scan' : 'never run')
                    : `${stats.runs} run${stats.runs === 1 ? '' : 's'}`
                      + (stats.failures ? `, ${stats.failures} failed` : '')
                      + (stats.medianMs ? ` · ~${fmtMs(stats.medianMs)}` : '')}
                </span>
                <span className="conn-meta">{open === agent.name ? '−' : '+'}</span>
              </button>

              {open === agent.name && (
                <dl className="agent-detail">
                  <dt>name</dt><dd><code>{agent.name}</code></dd>
                  <dt>runs as</dt><dd>{SURFACE_LABEL[agent.surface]}{agent.stage ? ` · ${agent.stage}` : ''}</dd>
                  <dt>instructions</dt><dd>{fmtChars(agent.instructionChars)}</dd>
                  <dt>effort</dt><dd>{agent.effort}</dd>
                  <dt>connectors</dt>
                  <dd>
                    {agent.connectors.length
                      ? agent.connectors.join(', ')
                      : 'none — tool-free by contract; it may only reason over what it is handed'}
                  </dd>
                  {agent.needsTools && (
                    <>
                      <dt>cannot run</dt>
                      <dd className="conn-err">
                        Its instructions tell it to go and search with the connectors above, and
                        nothing here can do that: agent runs have no tool loop, and the local
                        runtime rejects a request carrying both a JSON schema and a tools array.
                        Fired as it stands it would answer from memory and invent URLs, dates and
                        quotes. The pipeline does this work deterministically instead.
                      </dd>
                    </>
                  )}
                  {stats.lastError && (<><dt>last failure</dt><dd className="conn-err">{stats.lastError}</dd></>)}
                </dl>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
