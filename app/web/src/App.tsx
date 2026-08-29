import { useCallback, useEffect, useRef, useState } from 'react';
import { STAGES, type Issue, type LogLine, type Scan, type ScanEvent, type Stage } from '../../shared/types.ts';
import { Abuse } from './components/Abuse.tsx';
import { Buzz } from './components/Buzz.tsx';
import { FailureBox } from './components/FailureBox.tsx';
import { Health } from './components/Health.tsx';
import { Overview } from './components/Overview.tsx';
import { Presence, PresenceView } from './components/Presence.tsx';
import { RunDashboard, type RunSummary } from './components/RunDashboard.tsx';
import { api } from './lib.ts';

type Tab = 'overview' | 'presence' | 'discovery' | 'health' | 'integrity';

const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'presence', label: 'Presence' },
  { key: 'discovery', label: 'Discovery' },
  { key: 'health', label: 'Health' },
  { key: 'integrity', label: 'Integrity' },
];

const BLANK: Scan = {
  id: '', company: '', site: '', createdAt: '', status: 'done', stage: 'queued',
  profiles: [], mentions: [], issues: [], abuse: [], buzz: [], log: [], timings: {},
  verdict: '', net: { now: 0, delta: 0 },
};

export function App() {
  const [input, setInput] = useState('');
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [scan, setScan] = useState<Scan>(BLANK);
  const [stage, setStage] = useState<Stage>('queued');
  const [log, setLog] = useState<LogLine[]>([]);
  const [running, setRunning] = useState(false);
  const [rig, setRig] = useState<{ servers: string[]; model: string } | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [rerunningStage, setRerunningStage] = useState<Stage | null>(null);
  const source = useRef<EventSource | null>(null);
  const consoleRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    api<RunSummary[]>('/api/scans').then(setRuns).catch(() => setRuns([]));
  }, []);

  useEffect(() => { api<typeof rig>('/api/health').then(setRig).catch(() => setRig(null)); }, []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { consoleRef.current?.scrollTo({ top: 1e6 }); }, [log]);
  useEffect(() => () => source.current?.close(), []);

  const open = useCallback(async (id: string) => {
    source.current?.close();
    const previous = await api<Scan>(`/api/scans/${id}`);
    setScan({ ...previous, id });
    setStage(previous.stage);
    setLog([]);
    setCursor(null);
    setTab('overview');
    setRunning(false);
  }, []);

  const start = useCallback(async (company: string) => {
    source.current?.close();
    setScan({ ...BLANK, company });
    setLog([]);
    setCursor(null);
    setTab('overview');
    setRunning(true);
    setStage('presence');

    const { id } = await api<{ id: string }>('/api/scans', { method: 'POST', body: '{}' });
    const stream = new EventSource(`/api/scans/${id}/stream?company=${encodeURIComponent(company)}`);
    source.current = stream;

    stream.onmessage = (message) => {
      const event = JSON.parse(message.data) as ScanEvent;
      if (event.type === 'stage') setStage(event.stage);
      if (event.type === 'log') setLog((l) => [...l.slice(-200), event.line]);
      if (event.type === 'patch') setScan((s) => ({ ...s, ...event.scan, id }));
      if (event.type === 'done') { setScan(event.scan); setStage('done'); setRunning(false); refresh(); stream.close(); }
      if (event.type === 'error') {
        setScan((s) => ({
          ...s,
          status: 'error',
          error: event.message,
          errorDetail: event.detail,
          failedStage: event.stage,
        }));
        setRunning(false);
        refresh();
        stream.close();
      }
    };
    stream.onerror = () => { setRunning(false); stream.close(); };
  }, []);

  /** Re-run one or more stages on the currently loaded scan, in sequence,
   *  streamed over SSE so the tabs page in the results as they land. */
  const rerun = useCallback(async (stages: Stage[]) => {
    if (!scan.id || stages.length === 0) return;
    source.current?.close();
    setRerunningStage(stages[0]);
    setRunning(true);

    const runOne = (stage: Stage) =>
      new Promise<void>((resolve, reject) => {
        const stream = new EventSource(`/api/scans/${scan.id}/stages/${stage}/stream`);
        source.current = stream;
        stream.onmessage = (message) => {
          const event = JSON.parse(message.data) as ScanEvent;
          if (event.type === 'log') setLog((l) => [...l.slice(-200), event.line]);
          if (event.type === 'patch') setScan((s) => ({ ...s, ...event.scan, id: s.id }));
          if (event.type === 'done') {
            setScan((s) => ({
              ...s,
              ...event.scan,
              id: s.id,
              error: undefined,
              errorDetail: undefined,
              failedStage: undefined,
            }));
            stream.close();
            resolve();
          }
          if (event.type === 'error') {
            setScan((s) => ({
              ...s,
              status: 'error',
              error: event.message,
              errorDetail: event.detail,
              failedStage: event.stage,
            }));
            stream.close();
            reject();
          }
        };
        stream.onerror = () => { stream.close(); reject(new Error('stream dropped')); };
      });

    try {
      for (const stage of stages) {
        setRerunningStage(stage);
        setStage(stage);
        await runOne(stage);
      }
      refresh();
    } catch {
      // handled per-event; status already painted
    } finally {
      setRerunningStage(null);
      setRunning(false);
    }
  }, [scan.id, refresh]);

  const rerunStageFor = (tabKey: Tab): Stage[] | null => {
    switch (tabKey) {
      case 'presence': return ['presence'];
      case 'discovery': return ['discovery', 'buzz'];
      case 'health': return ['health'];
      case 'integrity': return ['abuse'];
      default: return null;
    }
  };

  const hasResult = scan.mentions.length > 0 || scan.profiles.length > 0;
  const stageIndex = STAGES.findIndex((s) => s.key === stage);

  return (
    <>
      <header className="masthead">
        <div className="wordmark">Whis<span>·</span>perer</div>
        <form
          onSubmit={(event) => { event.preventDefault(); if (input.trim()) start(input.trim()); }}
        >
          <input
            type="text"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Company name or website"
            aria-label="Company name or website"
            disabled={running}
          />
          <button className="primary" type="submit" disabled={running || !input.trim()}>
            {running ? 'Running' : 'Run'}
          </button>
        </form>
        <div className="rig">
          <span className={`lamp ${running ? 'busy' : rig ? 'live' : ''}`} />
          {rig ? `${rig.model} · ${rig.servers.length} connectors` : 'no api'}
        </div>
      </header>

      <div className="dash">
        <RunDashboard runs={runs} scan={scan} onOpen={open} />

        <main className="shell dash-main">
          {!hasResult && !running && (
            <div className="subject">
              <h1>What are they saying?</h1>
              <p style={{ maxWidth: '58ch', marginTop: 18, fontSize: 16, color: 'var(--ink-2)' }}>
                Name a company. Whisperer reads their site for every account they run, finds the
                public discussion about them across Reddit, Hacker News and the wider web, and draws
                how opinion has moved. Then it separates the grumbling from the actual defects, and
                writes the reply.
              </p>
              {rig && rig.servers.length === 0 && (
                <div className="notice" style={{ marginTop: 22, maxWidth: '62ch' }}>
                  <span className="tag warning">no connectors</span>
                  <span>No MCP servers are registered on this TrueForge instance, so discovery has nothing to search. Run <code>npm run setup</code> first.</span>
                </div>
              )}
            </div>
          )}

          {(hasResult || running) && (
            <div className="subject">
              <h1>{scan.company || input}</h1>
              {scan.site && (
                <div>
                  <a className="site" href={scan.site} target="_blank" rel="noreferrer">{scan.site.replace(/^https?:\/\//, '')}</a>
                </div>
              )}
              <Presence profiles={scan.profiles} />
            </div>
          )}

          {running && (
            <div className="panel">
              <div className="runbar">
                <div className="run-status">
                  <span className="run-word">Running</span>
                  <span className="steps">
                    {STAGES.map((step, i) => {
                      const active = stage === step.key;
                      const done = i < stageIndex || scan.stage === 'done';
                      return (
                        <span
                          key={step.key}
                          data-state={active ? 'active' : done ? 'done' : 'idle'}
                          title={step.label}
                          className="step"
                        >
                          <i className="dot" />
                        </span>
                      );
                    })}
                  </span>
                  <span className="run-label">
                    {rerunningStage
                      ? `Rerunning ${rerunningStage}`
                      : STAGES.find((s) => s.key === stage)?.blurb}
                  </span>
                </div>
                {log.length > 0 && (
                  <div className="console" ref={consoleRef}>
                    {log.map((line, i) => (
                      <div key={i} className={`log-line lvl-${line.level}`}>
                        <span className="log-time">{line.at.slice(11, 19)}</span>
                        <span className="log-stage">{line.stage}</span>
                        {line.text}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {scan.status === 'error' && scan.error && (
            <FailureBox
              stage={scan.failedStage}
              message={scan.error}
              detail={scan.errorDetail}
              running={rerunningStage !== null}
              onRetry={() => scan.failedStage && rerun([scan.failedStage])}
            />
          )}

          {(hasResult || running) && (
            <>
              <nav className="tabs" role="tablist" aria-label="Scan sections">
                {TABS.map((t) => (
                  <button
                    key={t.key}
                    role="tab"
                    aria-selected={tab === t.key}
                    className="tab"
                    onClick={() => setTab(t.key)}
                  >
                    {t.label}
                  </button>
                ))}
              </nav>

              <div className="tab-body" role="tabpanel">
                {tab === 'overview' && (
                  <Overview scan={scan} cursor={cursor} onScrub={setCursor} />
                )}

                {tab === 'presence' && (
                  <section>
                    <div className="rubric">
                      <h2>Presence</h2>
                      <p>Accounts found on the site, and what to sweep.</p>
                      <button
                        className="rerun"
                        onClick={() => rerun(rerunStageFor('presence')!)}
                        disabled={rerunningStage !== null}
                      >
                        {rerunningStage === 'presence' ? 'Running…' : '↻ Rerun'}
                      </button>
                    </div>
                    <PresenceView scan={scan} />
                  </section>
                )}

                {tab === 'discovery' && (
                  <section>
                    <div className="rubric">
                      <h2>Discovery</h2>
                      <p>Everything public said about them, and where.</p>
                      <button
                        className="rerun"
                        onClick={() => rerun(rerunStageFor('discovery')!)}
                        disabled={rerunningStage !== null}
                      >
                        {rerunningStage === 'discovery' ? 'Running…' : '↻ Rerun'}
                      </button>
                    </div>
                    <Buzz scan={scan} cursor={cursor} />
                  </section>
                )}

                {tab === 'health' && (
                  <section>
                    <div className="rubric">
                      <h2>Health</h2>
                      <p>Complaints triaged into things that can actually be fixed.</p>
                      <button
                        className="rerun"
                        onClick={() => rerun(rerunStageFor('health')!)}
                        disabled={rerunningStage !== null}
                      >
                        {rerunningStage === 'health' ? 'Running…' : '↻ Rerun'}
                      </button>
                    </div>
                    <Health
                      scan={scan}
                      onChange={(issue: Issue) =>
                        setScan((s) => ({ ...s, issues: s.issues.map((i) => (i.id === issue.id ? issue : i)) }))
                      }
                    />
                  </section>
                )}

                {tab === 'integrity' && (
                  <section>
                    <div className="rubric">
                      <h2>Integrity</h2>
                      <p>Impersonation, scams and other misuse of the brand.</p>
                      <button
                        className="rerun"
                        onClick={() => rerun(rerunStageFor('integrity')!)}
                        disabled={rerunningStage !== null}
                      >
                        {rerunningStage === 'abuse' ? 'Running…' : '↻ Rerun'}
                      </button>
                    </div>
                    <Abuse
                      scan={scan}
                      onStatus={(finding) =>
                        setScan((s) => ({ ...s, abuse: s.abuse.map((f) => (f.id === finding.id ? finding : f)) }))
                      }
                    />
                  </section>
                )}
              </div>
            </>
          )}
        </main>
      </div>
    </>
  );
}
