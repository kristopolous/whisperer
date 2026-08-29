import { useCallback, useEffect, useRef, useState } from 'react';
import { STAGES, type Issue, type Scan, type ScanEvent, type Stage } from '../../shared/types.ts';
import { Tape } from './charts/Tape.tsx';
import { Buzz } from './components/Buzz.tsx';
import { Health } from './components/Health.tsx';
import { Presence } from './components/Presence.tsx';
import { api, fmtMonth } from './lib.ts';

const BLANK: Scan = {
  id: '', company: '', site: '', createdAt: '', status: 'done', stage: 'queued',
  profiles: [], mentions: [], issues: [], buzz: [], verdict: '', net: { now: 0, delta: 0 },
};

export function App() {
  const [input, setInput] = useState('');
  const [scan, setScan] = useState<Scan>(BLANK);
  const [stage, setStage] = useState<Stage>('queued');
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [rig, setRig] = useState<{ servers: string[]; model: string } | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const source = useRef<EventSource | null>(null);
  const consoleRef = useRef<HTMLDivElement>(null);

  useEffect(() => { api<typeof rig>('/api/health').then(setRig).catch(() => setRig(null)); }, []);
  useEffect(() => { consoleRef.current?.scrollTo({ top: 1e6 }); }, [log]);
  useEffect(() => () => source.current?.close(), []);

  const start = useCallback(async (company: string) => {
    source.current?.close();
    setScan({ ...BLANK, company });
    setLog([]);
    setCursor(null);
    setRunning(true);
    setStage('presence');

    const { id } = await api<{ id: string }>('/api/scans', { method: 'POST', body: '{}' });
    const stream = new EventSource(`/api/scans/${id}/stream?company=${encodeURIComponent(company)}`);
    source.current = stream;

    stream.onmessage = (message) => {
      const event = JSON.parse(message.data) as ScanEvent;
      if (event.type === 'stage') { setStage(event.stage); setLog((l) => [...l, `▸ ${event.stage}`]); }
      if (event.type === 'log') setLog((l) => [...l.slice(-60), event.text]);
      if (event.type === 'patch') setScan((s) => ({ ...s, ...event.scan, id }));
      if (event.type === 'done') { setScan(event.scan); setStage('done'); setRunning(false); stream.close(); }
      if (event.type === 'error') {
        setLog((l) => [...l, `✗ ${event.message}`]);
        setScan((s) => ({ ...s, status: 'error', error: event.message }));
        setRunning(false);
        stream.close();
      }
    };
    stream.onerror = () => { setRunning(false); stream.close(); };
  }, []);

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

      <div className="shell">
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

        {(running || scan.status === 'error') && (
          <div className="panel">
            <div className="runbar">
              <div className="steps">
                {STAGES.map((step, i) => (
                  <div
                    key={step.key}
                    className="step"
                    data-state={stage === step.key ? 'active' : i < stageIndex || stage === 'done' ? 'done' : 'idle'}
                  >
                    <span className="dot" />
                    {step.label}
                    <span style={{ color: 'var(--ink-3)' }}>· {step.blurb}</span>
                  </div>
                ))}
              </div>
              {log.length > 0 && (
                <div className="console" ref={consoleRef}>
                  {log.map((line, i) => <div key={i}>{line}</div>)}
                </div>
              )}
              {scan.error && (
                <div className="notice">
                  <span className="tag critical">failed</span>
                  <span>{scan.error}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {scan.buzz.length > 0 && (
          <section>
            <div className="tape">
              <div className="tape-head">
                <h3>The tape</h3>
                <span style={{ font: '400 11px var(--mono)', color: 'var(--ink-3)' }}>
                  sentiment · {fmtMonth(scan.buzz[0].bucket)} — {fmtMonth(scan.buzz.at(-1)!.bucket)}
                </span>
              </div>
              <Tape buzz={scan.buzz} issues={scan.issues} cursor={cursor} onScrub={setCursor} />
              <div className="tape-foot">
                <span>
                  {cursor
                    ? `Filtered to ${fmtMonth(cursor)} — click the trace again to clear`
                    : 'Click the trace to filter the ledger to one month'}
                </span>
                <span style={{ display: 'inline-flex', gap: 14, alignItems: 'center' }}>
                  <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                    <i style={{ width: 9, height: 9, borderRadius: 2, background: 'var(--pen)' }} /> incident
                  </span>
                  <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                    <i style={{ width: 9, height: 9, borderRadius: 2, background: 'var(--pos)' }} /> positive
                  </span>
                  <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                    <i style={{ width: 9, height: 9, borderRadius: 2, background: 'var(--neg)' }} /> negative
                  </span>
                </span>
              </div>
            </div>
          </section>
        )}

        {scan.mentions.length > 0 && (
          <section>
            <div className="rubric">
              <h2>Buzz</h2>
              <p>How opinion moved, and who moved it.</p>
            </div>
            <Buzz scan={scan} cursor={cursor} />
          </section>
        )}

        {(scan.issues.length > 0 || (scan.status === 'done' && scan.mentions.length > 0)) && (
          <section>
            <div className="rubric">
              <h2>Health</h2>
              <p>Complaints triaged into things that can actually be fixed.</p>
            </div>
            <Health
              scan={scan}
              onChange={(issue: Issue) =>
                setScan((s) => ({ ...s, issues: s.issues.map((i) => (i.id === issue.id ? issue : i)) }))
              }
            />
          </section>
        )}
      </div>
    </>
  );
}
