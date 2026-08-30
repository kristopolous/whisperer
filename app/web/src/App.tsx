import { useCallback, useEffect, useRef, useState } from 'react';
import { STAGES, type Issue, type LogLine, type Scan, type ScanEvent, type Stage } from '../../shared/types.ts';
import { Abuse } from './components/Abuse.tsx';
import { Buzz } from './components/Buzz.tsx';
import { FailureBox } from './components/FailureBox.tsx';
import { FeedView } from './components/Feed.tsx';
import { Health } from './components/Health.tsx';
import { Login } from './components/Login.tsx';
import { Overview } from './components/Overview.tsx';
import { PresenceView } from './components/Presence.tsx';
import { RunDashboard, type RunSummary } from './components/RunDashboard.tsx';
import { SettingsPanel } from './components/SettingsPanel.tsx';
import { StatCards, type OverviewTab } from './components/StatCards.tsx';
import { api, cleanName, normalize, siteOf } from './lib.ts';

type Tab = 'overview' | 'presence' | 'discovery' | 'feed' | 'health' | 'integrity';

const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'feed', label: 'Feed' },
  { key: 'presence', label: 'Presence' },
  { key: 'discovery', label: 'Discovery' },
  { key: 'health', label: 'Health' },
  { key: 'integrity', label: 'Integrity' },
];

const TAB_KEYS = new Set<Tab>(TABS.map((t) => t.key));

const HASH_RE = /^#\/scan\/([^/?]+)(?:\/([a-z][a-z-]*))?/i;

/** Read `#/scan/<id>/<tab>` from the location. Returns null when no scan is linked. */
function parseHash(): { id: string; tab: Tab } | null {
  const m = window.location.hash.match(HASH_RE);
  if (!m || !m[1]) return null;
  const tab = (m[2] as Tab) ?? 'overview';
  return { id: m[1], tab: TAB_KEYS.has(tab) ? tab : 'overview' };
}

function hashFor(id: string, tab: Tab): string {
  return `#/scan/${id}/${tab}`;
}

const BLANK: Scan = {
  id: '', company: '', site: '', createdAt: '', status: 'done', stage: 'queued',
  profiles: [], mentions: [], issues: [], abuse: [], buzz: [], topics: [], migrations: [], feed: [], log: [], timings: {},
  verdict: '', net: { now: 0, delta: 0 },
};

/** Clock display for a run: `m:ss`, rolling to `h:mm:ss` past the hour. */
function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

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
  const [authed, setAuthed] = useState(() => sessionStorage.getItem('whisperer.auth') === '1');
  const [showSettings, setShowSettings] = useState(false);
  // Elapsed clocks: runStart/stageStart are wall-clock instants (ms) each set
  // when a run or a stage kicks off; clock is the live tick repainted every
  // second so a long, silent stage still visibly moves instead of looking hung.
  const [runStart, setRunStart] = useState<number>(Date.now());
  const [stageStart, setStageStart] = useState<number>(Date.now());
  const [clock, setClock] = useState<number>(Date.now());

  const openSettings = useCallback(() => {
    setShowSettings(true);
    source.current?.close();
    window.location.hash = '#/';
  }, []);

  const closeSettings = useCallback(() => setShowSettings(false), []);

  const login = useCallback(() => {
    sessionStorage.setItem('whisperer.auth', '1');
    setAuthed(true);
  }, []);

  const logout = useCallback(() => {
    sessionStorage.removeItem('whisperer.auth');
    setAuthed(false);
    window.location.hash = '#/';
  }, []);
  const source = useRef<EventSource | null>(null);
  const consoleRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scanIdRef = useRef<string>('');

  const refresh = useCallback(() => {
    api<RunSummary[]>('api/scans').then(setRuns).catch(() => setRuns([]));
  }, []);
useEffect(() => {
    api<typeof rig>('api/health').then(setRig).catch(() => setRig(null));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { consoleRef.current?.scrollTo({ top: 1e6 }); }, [log]);
  useEffect(() => () => source.current?.close(), []);
  // Live clock: while a run is in flight repaint the elapsed counters once a
  // second, so the panel shows progress even between log lines.
  useEffect(() => {
    if (!running) return;
    setClock(Date.now());
    const t = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  const applyHash = useCallback(async (id: string, tab: Tab) => {
    source.current?.close();
    // Update the selection synchronously (before the async fetch yields) so any
    // rerun / tab action taken in the load window targets THIS scan, not the
    // one that was on screen a moment ago.
    scanIdRef.current = id;
    const previous = await api<Scan>(`api/scans/${id}`);
    setScan(normalize({ ...previous, id }));
    setStage(previous.stage);
    setLog(previous.log ?? []);
    setCursor(null);
    setTab(tab);
    if (previous.status === 'running') {
      setRunning(true);
      attachStream(id, previous.company);
    } else {
      setRunning(false);
    }
  }, []);

  useEffect(() => {
    const sync = () => {
      const hit = parseHash();
      if (hit) void applyHash(hit.id, hit.tab);
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, [applyHash]);

  /** Open a scan from the rail: point the URL at it and let the hash change load it. */
  const open = useCallback((id: string) => {
    if (window.location.hash !== hashFor(id, 'overview')) {
      window.location.hash = hashFor(id, 'overview');
    } else {
      void applyHash(id, 'overview');
    }
  }, [applyHash]);

  /** Drop the current selection back to a blank canvas and focus the name box. */
  const onNew = useCallback(() => {
    source.current?.close();
    scanIdRef.current = '';
    setScan(BLANK);
    setLog([]);
    setCursor(null);
    setTab('overview');
    setRunning(false);
    setRerunningStage(null);
    if (window.location.hash && parseHash()) window.location.hash = '#/';
    inputRef.current?.focus();
  }, []);

  const attachStream = useCallback((id: string, company?: string) => {
    source.current?.close();
    const stream = new EventSource(`api/scans/${id}/stream${company ? `?company=${encodeURIComponent(company)}` : ''}`);
    source.current = stream;

    stream.onmessage = (message) => {
      const event = JSON.parse(message.data) as ScanEvent;
      if (event.type === 'stage') { setStage(event.stage); setStageStart(Date.now()); }
      if (event.type === 'log') setLog((l) => [...l.slice(-200), event.line]);
      if (event.type === 'patch') setScan((s) => ({ ...s, ...event.scan, id }));
      if (event.type === 'done') {
        scanIdRef.current = id;
        setScan(event.scan); setStage('done'); setRunning(false); refresh(); stream.close();
        if (parseHash()?.id !== id) window.location.hash = hashFor(id, 'overview');
      }
      if (event.type === 'error') {
        scanIdRef.current = id;
        setScan((s) => ({
          ...s,
          status: 'error',
          error: event.message,
          errorDetail: event.detail,
          failedStage: event.stage,
          errorKind: event.kind,
        }));
        setRunning(false);
        refresh();
        stream.close();
        if (parseHash()?.id !== id) window.location.hash = hashFor(id, 'overview');
      }
    };
    stream.onerror = () => {
      scanIdRef.current = id;
      setScan((s) => ({
        ...s,
        id,
        status: 'error',
        error: 'The scan stream was interrupted before it finished — the connection to the server dropped.',
        errorKind: 'other',
        failedStage: undefined,
      }));
      setRunning(false);
      refresh();
      stream.close();
      if (parseHash()?.id !== id) window.location.hash = hashFor(id, 'overview');
    };
  }, [refresh]);

  const start = useCallback(async (company: string) => {
    setScan({ ...BLANK, company: cleanName(company), site: siteOf(company) });
    setLog([]);
    setCursor(null);
    setTab('overview');
    setRunning(true);
    setStage('presence');
    setRunStart(Date.now());
    setStageStart(Date.now());

    const { id } = await api<{ id: string }>('api/scans', { method: 'POST', body: '{}' });
    scanIdRef.current = id;
    // The new run exists server-side the moment this returns — surface it in the
    // rail right away (as running) instead of waiting for the run to finish
    // (or crash) before the row ever appears.
    refresh();
    attachStream(id, company);
  }, [attachStream, refresh]);

  /** Re-run one or more stages on the currently loaded scan, in sequence,
   *  streamed over SSE so the tabs page in the results as they land.
   *
   *  The target scan id is read from the selection ref rather than the state
   *  closure: the ref is set synchronously the instant a site is picked in the
   *  rail, so a rerun can never hit a different site than the one highlighted. */
  const rerun = useCallback(async (stages: Stage[]) => {
    const target = scanIdRef.current;
    if (!target || stages.length === 0) return;
    source.current?.close();
    setRerunningStage(stages[0]);
    setRunning(true);
    setRunStart(Date.now());
    setStageStart(Date.now());
    // A rerun restarts the console: drop the previous run's log lines and any
    // stale error state so we see exactly this run's events.
    setLog([]);
    setScan((s) => ({
      ...s,
      id: target,
      status: 'running',
      error: undefined, errorDetail: undefined, failedStage: undefined, errorKind: undefined,
    }));

    const runOne = (stage: Stage, reset: boolean) =>
      new Promise<void>((resolve, reject) => {
        let settled = false;
        const stream = new EventSource(`api/scans/${target}/stages/${stage}/stream${reset ? '?reset=1' : ''}`);
        source.current = stream;
        stream.onopen = () => {
          setLog((l) => [
            ...l.slice(-200),
            { at: new Date().toISOString(), level: 'info', stage, text: `rerunning ${stage}…` },
          ]);
        };
        stream.onmessage = (message) => {
          const event = JSON.parse(message.data) as ScanEvent;
          if (event.type === 'log') setLog((l) => [...l.slice(-200), event.line]);
          if (event.type === 'patch') setScan((s) => ({ ...s, ...event.scan, id: s.id }));
          if (event.type === 'done') {
            if (settled) return;
            settled = true;
            setScan((s) => ({
              ...s,
              ...event.scan,
              id: s.id,
              error: undefined,
              errorDetail: undefined,
              failedStage: undefined,
              errorKind: undefined,
            }));
            stream.close();
            resolve();
          }
          if (event.type === 'error') {
            if (settled) return;
            settled = true;
            setScan((s) => ({
              ...s,
              status: 'error',
              error: event.message,
              errorDetail: event.detail,
              failedStage: event.stage,
              errorKind: event.kind,
            }));
            setStage(stage);
            stream.close();
            reject();
          }
        };
        stream.onerror = () => {
          if (settled) return;
          settled = true;
          stream.close();
          setScan((s) => ({
            ...s,
            status: 'error',
            stage,
            failedStage: stage,
            error: 'Rerun dropped before it could report back',
            errorKind: 'connector',
            errorDetail: `The stage stream on /api/scans/${target}/stages/${stage}/stream closed without a result (missing stage data, or the server ended the stream early).`,
          }));
          reject(new Error('stream dropped'));
        };
      });

    try {
      for (const [i, stage] of stages.entries()) {
        setRerunningStage(stage);
        setStage(stage);
        setStageStart(Date.now());
        await runOne(stage, i === 0);
      }
      refresh();
    } catch {
      // handled per-event; status already painted
    } finally {
      setRerunningStage(null);
      setRunning(false);
    }
  }, [refresh]);

  const rerunStageFor = (tabKey: Tab): Stage[] | null => {
    switch (tabKey) {
      case 'presence': return ['presence'];
      case 'discovery': return ['discovery', 'buzz'];
      case 'feed': return ['feed'];
      case 'health': return ['health'];
      case 'integrity': return ['abuse'];
      default: return null;
    }
  };

  const hasScan = !!scan.id;
  const stageIndex = STAGES.findIndex((s) => s.key === stage);

  if (!authed) return <Login onLogin={login} />;

  return (
    <>
      <header className="masthead">
        <div className="wordmark">Whis<span>·</span>perer</div>
        <div className="masthead-tag">reputation forensics</div>
        <div className="rig">
          <span className={`lamp ${running ? 'busy' : rig ? 'live' : ''}`} />
          {rig ? `${rig.model} · ${rig.servers.length} connectors` : 'no api'}
          <button className="logout" onClick={openSettings} title="Connector API keys">settings</button>
          <button className="logout" onClick={logout} title="Sign out">sign out</button>
        </div>
      </header>

      <div className="dash">
        <RunDashboard
          runs={runs}
          activeId={scan.id}
          onOpen={open}
          onNew={onNew}
        />

        <main className="shell dash-main">
          {showSettings ? (
            <SettingsPanel onClose={closeSettings} />
          ) : (
          <>
          {!hasScan && !running && (
            <div className="subject landing">
              <h1>What are they saying?</h1>
              <p style={{ maxWidth: '58ch', marginTop: 18, fontSize: 16, color: 'var(--ink-2)' }}>
                Name a company. Whisperer reads their site for every account they run, finds the
                public discussion about them across Reddit, Hacker News and the wider web, and draws
                how opinion has moved. Then it separates the grumbling from the actual defects, and
                writes the reply.
              </p>
              <form
                className="run-company"
                onSubmit={(event) => { event.preventDefault(); if (input.trim()) start(input.trim()); }}
              >
                <input
                  ref={inputRef}
                  type="text"
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder="Company name or website"
                  aria-label="Company name or website"
                  disabled={running}
                />
                <button className="primary" type="submit" disabled={!input.trim()}>
                  Run
                </button>
              </form>
              {rig && rig.servers.length === 0 && (
                <div className="notice" style={{ marginTop: 22, maxWidth: '62ch' }}>
                  <span className="tag warning">no connectors</span>
                  <span>No MCP servers are registered on this TrueForge instance, so discovery has nothing to search. Run <code>npm run setup</code> first.</span>
                </div>
              )}
            </div>
          )}

          {(hasScan || running) && (
            <div className="subject">
              <h1>{scan.company}</h1>
              {scan.site && (
                <div>
                  <a className="site" href={scan.site} target="_blank" rel="noreferrer">{scan.site.replace(/^https?:\/\//, '')}</a>
                </div>
              )}
            </div>
          )}

          {running && (
            <div className="panel">
              <div className="runbar">
                <div className="run-head">
                  <div className="run-title">
                    <span className="run-word">Running</span>
                    <span className="run-step">
                      {rerunningStage
                        ? `Rerunning ${STAGES.find((s) => s.key === rerunningStage)?.label ?? rerunningStage}`
                        : `${STAGES.find((s) => s.key === stage)?.label ?? stage} — step ${stageIndex + 1} of ${STAGES.length}`}
                    </span>
                  </div>
                  <div className="run-clock">
                    <span className="run-clock-box">
                      <span className="clock-label">this stage</span>
                      <span className={`clock-time ${clock - stageStart > 10 * 60_000 ? 'warn' : ''}`}>{fmtElapsed(clock - stageStart)}</span>
                    </span>
                    <span className="run-clock-box">
                      <span className="clock-label">total</span>
                      <span className={`clock-time ${clock - runStart > 25 * 60_000 ? 'warn' : ''}`}>{fmtElapsed(clock - runStart)}</span>
                    </span>
                  </div>
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
                </div>
                <div className="run-now">
                  <span className="now-label">now</span>
                  <span className="now-text">
                    {log.length > 0
                      ? log[log.length - 1].text
                      : STAGES.find((s) => s.key === stage)?.blurb}
                  </span>
                </div>
                {log.length > 1 && (
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
              kind={scan.errorKind}
              running={rerunningStage !== null}
              onRetry={() => scan.failedStage && rerun([scan.failedStage])}
              onRerunAll={() => rerun(STAGES.map((s) => s.key))}
            />
          )}

          {(hasScan || running) && (
            <>
              <StatCards
                scan={scan}
                onDrill={(targetTab) => { setTab(targetTab); if (scanIdRef.current) window.location.hash = hashFor(scanIdRef.current, targetTab); }}
              />
              <nav className="tabs" role="tablist" aria-label="Scan sections">
                {TABS.map((t) => (
                  <button
                    key={t.key}
                    role="tab"
                    aria-selected={tab === t.key}
                    className="tab"
                    onClick={() => { setTab(t.key); if (scanIdRef.current) window.location.hash = hashFor(scanIdRef.current, t.key); }}
                  >
                    {t.label}
                  </button>
                ))}
              </nav>

              <div className="tab-body" role="tabpanel">
                {tab === 'overview' && (
                  <Overview
                    scan={scan}
                    cursor={cursor}
                    onScrub={setCursor}
                  />
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

                {tab === 'feed' && (
                  <section>
                    <div className="rubric">
                      <h2>Feed</h2>
                      <p>The latest videos, comments and posts coming in about the company — with the source, the text, and a link (or the video itself) to go look.</p>
                      <button
                        className="rerun"
                        onClick={() => rerun(rerunStageFor('feed')!)}
                        disabled={rerunningStage !== null}
                      >
                        {rerunningStage === 'feed' ? 'Running…' : '↻ Rerun'}
                      </button>
                    </div>
                    <FeedView scan={scan} />
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
            </>
          )}
        </main>
      </div>
    </>
  );
}
