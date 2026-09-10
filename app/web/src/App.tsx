import { useCallback, useEffect, useRef, useState } from 'react';
import { STAGES, type Issue, type LogLine, type Scan, type ScanEvent, type Stage } from '../../shared/types.ts';
import { Abuse } from './components/Abuse.tsx';
import { Buzz } from './components/Buzz.tsx';
import { FailureBox } from './components/FailureBox.tsx';
import { FeedView } from './components/Feed.tsx';
import { Health } from './components/Health.tsx';
import { ProjectPanel } from './components/ProjectPanel.tsx';
import { Login } from './components/Login.tsx';
import { Overview } from './components/Overview.tsx';
import { SourcesView } from './components/Sources.tsx';
import { RunDashboard, type RunSummary } from './components/RunDashboard.tsx';
import { AgentsPanel } from './components/AgentsPanel.tsx';
import { OutboxPanel } from './components/OutboxPanel.tsx';
import { QueuePanel } from './components/QueuePanel.tsx';
import { SettingsPanel } from './components/SettingsPanel.tsx';
import { StatCards, type OverviewTab } from './components/StatCards.tsx';
import { api, apiUrl, cleanName, normalize, siteOf } from './lib.ts';

/** `defects` was called `health`, and sat fifth. Finding a real complaint,
 *  reading it against real code and patching it is what this product is for —
 *  it does not belong behind a sentiment chart, and "Health" does not say what
 *  it holds. The old key still resolves so existing links keep working. */
type Tab = 'defects' | 'overview' | 'presence' | 'discovery' | 'feed' | 'integrity' | 'project';

const TABS: { key: Tab; label: string }[] = [
  { key: 'defects', label: 'Defects' },
  { key: 'overview', label: 'Overview' },
  { key: 'feed', label: 'Feed' },
  { key: 'presence', label: 'Sources' },
  { key: 'discovery', label: 'Discovery' },
  { key: 'integrity', label: 'Integrity' },
  { key: 'project', label: 'Project' },
];

/** Tab keys that used to be called something else. */
const TAB_ALIASES: Record<string, Tab> = { health: 'defects' };

const TAB_KEYS = new Set<Tab>(TABS.map((t) => t.key));

const HASH_RE = /^#\/scan\/([^/?]+)(?:\/([a-z][a-z-]*))?/i;

/** Read `#/scan/<id>/<tab>` from the location. Returns null when no scan is linked. */
function parseHash(): { id: string; tab: Tab } | null {
  const m = window.location.hash.match(HASH_RE);
  if (!m || !m[1]) return null;
  const raw = (m[2] ?? '') as Tab;
  const tab = TAB_ALIASES[raw] ?? raw;
  return { id: m[1], tab: TAB_KEYS.has(tab) ? tab : 'defects' };
}

function hashFor(id: string, tab: Tab): string {
  return `#/scan/${id}/${tab}`;
}

/** The full-page views that are not a scan.
 *
 *  These used to be React state with `#/` in the location, so the URL said
 *  nothing about what was on screen: a reload from Settings — or ctrl+R, or a
 *  restored session, or sending someone the link — landed back on the scan
 *  view. They are real destinations, so they get real routes. */
const VIEWS = ['settings', 'agents', 'outbox', 'queue'] as const;
type View = (typeof VIEWS)[number];
const VIEW_RE = /^#\/(settings|agents|outbox|queue)\b/i;

function parseView(): View | null {
  const m = window.location.hash.match(VIEW_RE);
  return m ? (m[1]!.toLowerCase() as View) : null;
}

const BLANK: Scan = {
  id: '', company: '', site: '', createdAt: '', status: 'done', stage: 'queued',
  profiles: [], mentions: [], issues: [], abuse: [], buzz: [], topics: [], migrations: [], reviews: [],
  feed: [], log: [], timings: {},
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
  /** When this page last heard anything from a run. A stage can legitimately go
   *  quiet for a minute; quiet for ten is the difference between working and
   *  stuck, and nothing on screen could tell those apart. */
  const [lastEventAt, setLastEventAt] = useState<number>(() => Date.now());
  /** The scan this page started, and the stage it is on.
   *
   *  Held by id rather than read off the scan being viewed. Runs are
   *  property-centric and outlive the page: starting one on Replit and then
   *  opening Bolt had the indicator rename the running job to Bolt, because it
   *  was describing the screen instead of the work. */
  const [ownRun, setOwnRun] = useState<{ id: string; company: string; stage?: Stage } | null>(null);
  const [scan, setScan] = useState<Scan>(BLANK);
  const [stage, setStage] = useState<Stage>('queued');
  const [log, setLog] = useState<LogLine[]>([]);
  const [running, setRunning] = useState(false);
  const [rig, setRig] = useState<{ servers: string[]; model: string } | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('defects');
  const [rerunningStage, setRerunningStage] = useState<Stage | null>(null);
  /** What was just put in the queue, so a click that enqueues is not silent. */
  const [queuedNote, setQueuedNote] = useState<string | null>(null);
  /** Whether anything is running, readable synchronously inside a callback —
   *  the state closure is a render behind, and this decides whether a click
   *  starts work or joins the line. */
  const busyRef = useRef(false);
  const [authed, setAuthed] = useState(() => sessionStorage.getItem('whisperer.auth') === '1');
  const [showSettings, setShowSettings] = useState(false);
  const [showAgents, setShowAgents] = useState(false);
  const [showOutbox, setShowOutbox] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  // Elapsed clocks: runStart/stageStart are wall-clock instants (ms) each set
  // when a run or a stage kicks off; clock is the live tick repainted every
  // second so a long, silent stage still visibly moves instead of looking hung.
  const [runStart, setRunStart] = useState<number>(Date.now());
  const [stageStart, setStageStart] = useState<number>(Date.now());
  const [clock, setClock] = useState<number>(Date.now());

  /** Put one of the full-page views on screen. Exactly one at a time. */
  const applyView = useCallback((view: View | null) => {
    setShowSettings(view === 'settings');
    setShowAgents(view === 'agents');
    setShowOutbox(view === 'outbox');
    setShowQueue(view === 'queue');
  }, []);

  /** Open a full-page view by navigating to it.
   *
   *  Only the hash is set here; the hashchange listener applies the state. One
   *  path in means the URL and what is rendered cannot disagree, which is
   *  exactly what went wrong when these were state-only — and it makes the
   *  back button work for free. */
  const openView = useCallback((view: View) => {
    source.current?.close();
    const target = `#/${view}`;
    if (window.location.hash === target) applyView(view);
    else window.location.hash = target;
  }, [applyView]);

  const openSettings = useCallback(() => openView('settings'), [openView]);

  /** Leaving a full-page view goes back to the scan that was open, when there
   *  was one — the hash is the only record of that, and dropping to `#/` would
   *  make "back to scans" quietly mean "back to nothing". */
  const closeView = useCallback(() => {
    const id = scanIdRef.current;
    window.location.hash = id ? hashFor(id, 'defects') : '#/';
    setShowSettings(false);
    setShowAgents(false);
    setShowOutbox(false);
  }, []);

  const closeSettings = closeView;

  // The agent list is deliberately not a scan tab: it is about the machinery
  // rather than about one company's results, and it stays useful — arguably is
  // most useful — when a scan has just failed and there is nothing to show.
  const openOutbox = useCallback(() => openView('outbox'), [openView]);
  const openQueue = useCallback(() => openView('queue'), [openView]);

  const closeOutbox = closeView;
  const closeQueue = closeView;

  const openAgents = useCallback(() => openView('agents'), [openView]);

  const closeAgents = closeView;

  /** Delete a company's scans, then reconcile the view.
   *
   *  If the row being removed is the one on screen, the canvas has to go back
   *  to the landing state — leaving a deleted scan rendered, with tabs that
   *  fetch 404s, is worse than an empty page. */
  const removeRun = useCallback(async (id: string) => {
    const wasOpen = scanIdRef.current === id;
    const { runs: remaining } = await api<{ removed: string[]; runs: RunSummary[] }>(
      `api/scans/${id}`, { method: 'DELETE' },
    );
    setRuns(remaining);
    if (wasOpen) {
      source.current?.close();
      scanIdRef.current = '';
      setScan(BLANK);
      setLog([]);
      setStage('queued');
      setRunning(false);
      window.location.hash = '#/';
    }
  }, []);

  const [stopping, setStopping] = useState(false);

  /** Ask the running scan to stop.
   *
   *  Optimistic only as far as the button label: the run is not marked
   *  cancelled here. It stops at its own next checkpoint and reports that over
   *  the stream, so what the dashboard shows is what actually happened rather
   *  than what was requested. */
  const stop = useCallback(async () => {
    const id = scanIdRef.current;
    if (!id) return;
    setStopping(true);
    try {
      await api<{ stopping: boolean }>(`api/scans/${id}/cancel`, { method: 'POST', body: '{}' });
    } catch {
      // Nothing to do about a failed cancel but let the run carry on; the
      // stream will say what it is doing.
      setStopping(false);
    }
  }, []);

  // The button resets when the run settles, however it settled — cancelled,
  // finished, or failed on its own before the cancel arrived.
  useEffect(() => { if (!running) setStopping(false); }, [running]);

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
    // Opening a scan means leaving whatever full-page view was up: settings,
    // the agent list and the outbox all render instead of the scan, so a rail
    // click behind one of them would load the scan invisibly and read as the
    // click having done nothing.
    //
    // Belt and braces with the hash sync, which also clears them. This path can
    // be reached without a hashchange — `open` calls straight through when the
    // hash already names the scan — and a stale view flag here means a loaded
    // scan that cannot be seen.
    setShowSettings(false);
    setShowAgents(false);
    setShowOutbox(false);
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

  // The single place the URL becomes state, for every kind of destination.
  // Runs once on mount too, which is what makes ctrl+R come back to where you
  // were rather than to the scan view.
  useEffect(() => {
    const sync = () => {
      const view = parseView();
      if (view) {
        applyView(view);
        return;
      }
      applyView(null);
      const hit = parseHash();
      if (hit) void applyHash(hit.id, hit.tab);
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, [applyHash, applyView]);

  /** Open a scan from the rail: point the URL at it and let the hash change load it. */
  const open = useCallback((id: string) => {
    // Straight to the defects. It is what the tool is for, and a scan that
    // found none says so plainly on that tab — which is itself the answer
    // somebody opened it to get.
    if (window.location.hash !== hashFor(id, 'defects')) {
      window.location.hash = hashFor(id, 'defects');
    } else {
      void applyHash(id, 'defects');
    }
  }, [applyHash]);

  /** Drop the current selection back to a blank canvas and focus the name box. */
  const onNew = useCallback(() => {
    source.current?.close();
    scanIdRef.current = '';
    setScan(BLANK);
    setLog([]);
    setCursor(null);
    setTab('defects');
    setRunning(false);
    setRerunningStage(null);
    if (window.location.hash && parseHash()) window.location.hash = '#/';
    inputRef.current?.focus();
  }, []);

  const attachStream = useCallback((id: string, company?: string) => {
    source.current?.close();
    const stream = new EventSource(apiUrl(`api/scans/${id}/stream${company ? `?company=${encodeURIComponent(company)}` : ''}`));
    source.current = stream;

    stream.onmessage = (message) => {
      setLastEventAt(Date.now());
      const event = JSON.parse(message.data) as ScanEvent;
      if (event.type === 'stage') { setStage(event.stage); setStageStart(Date.now()); }
      if (event.type === 'log') setLog((l) => [...l.slice(-200), event.line]);
      if (event.type === 'patch') {
        setScan((s) => ({ ...s, ...event.scan, id }));
        // The resolver renames the subject mid-run — a repository URL comes in
        // as its path and comes out as what the project is actually called — so
        // the runs rail has to be told. It used to refresh only at `done`,
        // which left the old name sitting in the list for the length of a scan.
        if (event.scan.company || event.scan.site) refresh();
      }
      if (event.type === 'done') {
        scanIdRef.current = id;
        setScan(event.scan); setStage('done'); setRunning(false); refresh(); stream.close();
        if (parseHash()?.id !== id) window.location.hash = hashFor(id, 'defects');
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
        if (parseHash()?.id !== id) window.location.hash = hashFor(id, 'defects');
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
      if (parseHash()?.id !== id) window.location.hash = hashFor(id, 'defects');
    };
  }, [refresh]);

  const start = useCallback(async (company: string) => {
    setScan({ ...BLANK, company: cleanName(company), site: siteOf(company) });
    setLog([]);
    setCursor(null);
    setTab('defects');
    setRunning(true);
    setStage('presence');
    setRunStart(Date.now());
    setStageStart(Date.now());

    const { id } = await api<{ id: string }>('api/scans', {
      method: 'POST',
      body: JSON.stringify({ company }),
    });
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
  // The server is the authority on what is running.
  //
  // Local `running` is set when a stream opens and cleared when it settles — so
  // a stream that stalls without erroring leaves it true forever, the snackbar
  // never goes away and every Rerun button stays disabled. The runs list is
  // already polled; if it says nothing is in flight and nothing has arrived on
  // the wire for a while, believe it.
  useEffect(() => {
    if (!running && rerunningStage === null) return;
    const anyRunning = (runs ?? []).some((r) => r.status === 'running');
    if (anyRunning) return;
    if (Date.now() - lastEventAt < 30_000) return;
    setRunning(false);
    setRerunningStage(null);
  }, [runs, running, rerunningStage, lastEventAt]);

  // The server is the authority on what is running.
  //
  // Local `running` is set when a stream opens and cleared when it settles, so
  // a stream that dies without erroring leaves it true forever: the snackbar
  // never clears and every Rerun button stays disabled. The runs list is polled
  // anyway — if it says nothing is in flight and nothing has come over the wire
  // for half a minute, believe it.
  useEffect(() => {
    if (!running && rerunningStage === null) return;
    if ((runs ?? []).some((r) => r.status === 'running')) return;
    if (Date.now() - lastEventAt < 30_000) return;
    setRunning(false);
    setRerunningStage(null);
  }, [runs, running, rerunningStage, lastEventAt]);

  // Anything the server says is in flight, whichever scan it belongs to.
  // `runs` is refreshed on a timer already, so this costs nothing extra.
  const busyRuns = (runs ?? []).filter((run) => run.status === 'running');
  busyRef.current = busyRuns.length > 0 || running || rerunningStage !== null;

  useEffect(() => {
    if (!queuedNote) return;
    const timer = setTimeout(() => setQueuedNote(null), 6_000);
    return () => clearTimeout(timer);
  }, [queuedNote]);

  // How many jobs are waiting, for the header badge. Polled with the runs list
  // rather than on its own timer — a queue that moves without saying so is the
  // thing this is meant to fix.
  const [waiting, setWaiting] = useState(0);
  /** Scans with work waiting on them, so the rail can say so.
   *
   *  A queued scan is not a running one and has no state of its own on the
   *  record — from the rail it looks exactly like a scan nobody has touched.
   *  That is the same failure the queue was built to end: a job that starts in
   *  four minutes and a job that silently never started must not look alike,
   *  and the rail is where somebody looks for a property. */
  const [queuedIds, setQueuedIds] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    const read = () => {
      api<{ waiting: number; jobs: { scanId: string; state: string }[] }>('api/jobs')
        .then((data) => {
          if (!live) return;
          setWaiting(data.waiting);
          setQueuedIds((data.jobs ?? []).filter((job) => job.state === 'queued').map((job) => job.scanId));
        })
        .catch(() => {});
    };
    read();
    const timer = setInterval(read, 5_000);
    return () => { live = false; clearInterval(timer); };
  }, []);

  const rerun = useCallback(async (stages: Stage[], options?: { depth?: 'deep' | 'normal'; languages?: string[]; dig?: string }) => {
    const target = scanIdRef.current;
    if (!target || stages.length === 0) return;

    // Something is already in flight, so this goes in the queue.
    //
    // The buttons used to disable while ANY run was going, anywhere. Runs are
    // property-centric and the queue exists precisely so a second ask is
    // remembered rather than refused — but the controls still behaved as though
    // it did not, so starting a Replit run made every Rerun button on Bolt dead.
    // Work is serialised either way; the only question is whether asking for it
    // is possible, and there is no reason it should not be.
    if (busyRef.current) {
      try {
        const { waiting } = await api<{ waiting: number }>('api/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scanId: target, stages, ...options }),
        });
        setWaiting(waiting);
        setQueuedNote(
          `${cleanName(scan.company) || 'Scan'} queued`
          + (waiting > 1 ? ` — ${waiting} waiting` : ''),
        );
      } catch (error) {
        setQueuedNote(String(error).replace(/^Error:\s*/, '').slice(0, 120));
      }
      return;
    }
    setOwnRun({ id: target, company: cleanName(scan.company), stage: stages[0] });
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
        const params = new URLSearchParams();
        if (reset) params.set('reset', '1');
        if (options?.depth) params.set('depth', options.depth);
        if (options?.languages) params.set('languages', options.languages.join(','));
        if (options?.dig) params.set('dig', options.dig);
        const query = params.toString();
        const stream = new EventSource(apiUrl(`api/scans/${target}/stages/${stage}/stream${query ? `?${query}` : ''}`));
        source.current = stream;
        stream.onopen = () => {
          setLog((l) => [
            ...l.slice(-200),
            { at: new Date().toISOString(), level: 'info', stage, text: `rerunning ${stage}…` },
          ]);
        };
        stream.onmessage = (message) => {
          setLastEventAt(Date.now());
          const event = JSON.parse(message.data) as ScanEvent;
          if (event.type === 'log') setLog((l) => [...l.slice(-200), event.line]);
          if (event.type === 'patch') {
            setScan((s) => ({ ...s, ...event.scan, id: s.id }));
            if (event.scan.company || event.scan.site) refresh();
          }
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

  /** Which stages to run to fill a given card. Discovery drags buzz with it:
   *  a fresh corpus that nothing has scored leaves sentiment and topics empty,
   *  which is the state the card was complaining about in the first place. */
  const STAGE_RERUN: Partial<Record<Stage, Stage[]>> = {
    presence: ['presence'],
    discovery: ['discovery', 'buzz'],
    feed: ['feed'],
    buzz: ['buzz'],
    health: ['health'],
    abuse: ['abuse'],
  };

  const rerunStageFor = (tabKey: Tab): Stage[] | null => {
    switch (tabKey) {
      case 'presence': return ['presence'];
      case 'discovery': return ['discovery', 'buzz'];
      case 'feed': return ['feed'];
      case 'defects': return ['health'];
      case 'integrity': return ['abuse'];
      default: return null;
    }
  };

  const hasScan = !!scan.id;
  const stageIndex = STAGES.findIndex((s) => s.key === stage);

  if (!authed) return <Login onLogin={login} />;

  return (
    <>
      {/* Work started from halfway down a page needs to say so where the click
          happened. The run panel lives above the tabs, which is off-screen from
          any empty state that offers an action. */}
      {/* Every run in flight, named by the company it belongs to. Server truth
          first, so a run somebody else started — or one this page started and
          then navigated away from — is still accounted for. */}
      {(() => {
        const live = busyRuns.map((r) => ({ id: r.id, company: cleanName(r.company), stage: r.stage }));
        const shown = live.length === 0 && ownRun && (running || rerunningStage !== null)
          ? [{ ...ownRun, stage: rerunningStage ?? ownRun.stage }]
          : live;
        if (shown.length === 0 && !queuedNote) return null;
        return (
          <div className="snack" role="status">
            {queuedNote && <span className="snack-queued">{queuedNote}</span>}
            {shown.map((run) => (
              <button key={run.id} className="snack-run" onClick={() => open(run.id)}>
                <span className="lamp busy" />
                <b>{run.company || 'Scan'}</b>
                {run.stage ? ` · ${STAGES.find((s) => s.key === run.stage)?.label ?? run.stage}` : ''}
              </button>
            ))}
          </div>
        );
      })()}

      <header className="masthead">
        <div className="wordmark">Whis<span>·</span>perer</div>
        <div className="masthead-tag">reputation forensics</div>
        <div className="rig">
          {/* What is running, anywhere.
              A scan keeps going on the server whether or not this page is
              watching it, and every Rerun button in the app disables while one
              is in flight — so without this a dimmed button has no visible
              cause, on a tab that may not even be the scan that is busy. */}
          {busyRuns.map((run) => (
            <button
              key={run.id}
              className="running-now"
              onClick={() => open(run.id)}
              title={`${run.company} is running ${run.stage} — click to watch it`}
            >
              <span className="lamp busy" />
              {run.company} · {run.stage}
            </button>
          ))}
          {busyRuns.length === 0 && <span className={`lamp ${running ? 'busy' : rig ? 'live' : ''}`} />}
          <span className="rig-model" title={rig ? `${rig.model} · ${rig.servers.length} connectors` : 'no api'}>
            {rig ? `${rig.model} · ${rig.servers.length} connectors` : 'no api'}
          </span>
          <button className="logout" onClick={openAgents} title="Agents and their runs">agents</button>
          <button className="logout" onClick={openQueue} title="What is running and what is waiting">
            queue
            {/* A badge, not a number appended to the word. Work waiting is a
                thing to notice from across the room; set in the header's own
                muted type it read as part of the label. */}
            {waiting > 0 && <span className="badge">{waiting}</span>}
          </button>
          <button className="logout" onClick={openOutbox} title="Replies drafted but never sent">outbox</button>
          <button className="logout" onClick={openSettings} title="Connector API keys">settings</button>
          <button className="logout" onClick={logout} title="Sign out">sign out</button>
        </div>
      </header>

      <div className="dash">
        <RunDashboard
          runs={runs}
          queued={queuedIds}
          activeId={scan.id}
          onOpen={open}
          onNew={onNew}
          onRemove={removeRun}
        />

        <main className="shell dash-main">
          {showQueue ? (
            <QueuePanel onClose={closeQueue} onOpenScan={open} />
          ) : showOutbox ? (
            <OutboxPanel onClose={closeOutbox} />
          ) : showAgents ? (
            <AgentsPanel onClose={closeAgents} />
          ) : showSettings ? (
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
                  <span>
                    No MCP connectors are usable — check <code>config/connectors.json</code> and the
                    credentials it names in Settings. Search itself only needs <code>BRAVE_API_KEY</code>,
                    so a scan may still work; the connectors add the venue-specific reach.
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Said once, at the top, before any number below it is read. The
              fixture's retrieval data is real and its judgements are not, and
              that is not a distinction anyone can make by looking at a chart. */}
          {scan.fixture && (
            <div className="notice">
              <span className="tag warning">demonstration</span>
              <span>
                A seeded fixture, not a scan. The accounts, mentions and links are real and were
                collected by a genuine run; the sentiment scores, the issues and the verdict were
                written by hand to show a populated dashboard. Nothing here is a finding about
                {' '}{scan.company}.
              </span>
            </div>
          )}

          {(hasScan || running) && (
            <div className="subject">
              <h1>{scan.company}</h1>
              <div className="subject-line">
                {scan.site && (
                  <a className="site" href={scan.site} target="_blank" rel="noreferrer">{scan.site.replace(/^https?:\/\//, '')}</a>
                )}
              </div>
              {/* The three things this product does, on the subject rather than
                  behind a tab. Rerun answers "is this still true", Deeper
                  answers "did we look far enough", and Patch bugs is the one
                  the whole pipeline exists to reach. Each was previously a
                  control inside whichever tab happened to own its stage, which
                  made the headline features the hardest ones to find. */}
              <div className="subject-actions">
                <button
                  className="headline"
                  onClick={() => rerun(['discovery', 'buzz', 'health', 'abuse'])}
                  title="Search again and re-triage — a fresh observation of what people are saying now"
                >
                  ↻ Rerun
                </button>
                <button
                  className="headline"
                  onClick={() => rerun(['discovery', 'buzz'], { depth: 'deep' })}
                  title="Walk every window back to all-time instead of stopping once there is enough, and lift the corpus caps"
                >
                  ⤓ Deeper
                </button>
                <button
                  className="headline"
                  onClick={() => setTab('defects')}
                  disabled={running}
                  title="Read the source against a defect, write a patch, and run the tests"
                >
                  ⚒ Patch bugs
                  {scan.issues.length > 0 && <span className="headline-n">{scan.issues.length}</span>}
                </button>
              </div>
            </div>
          )}

          {running && (
            <div className="panel runbar-sticky">
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
                    {/* Silence is the only symptom of a stuck stage, so it is
                        measured rather than left to be felt. */}
                    <span className="run-clock-box">
                      <span className="clock-label">last output</span>
                      <span className={`clock-time ${clock - lastEventAt > 120_000 ? 'warn' : ''}`}>
                        {fmtElapsed(clock - lastEventAt)}
                      </span>
                    </span>
                    <span className="run-clock-box">
                      <span className="clock-label">total</span>
                      <span className={`clock-time ${clock - runStart > 25 * 60_000 ? 'warn' : ''}`}>{fmtElapsed(clock - runStart)}</span>
                    </span>
                    {/* Next to the clock deliberately: the moment somebody
                        wants to stop a run is the moment they are watching how
                        long it has taken. */}
                    <button className="rerun" onClick={stop} disabled={stopping}>
                      {stopping ? 'Stopping…' : '■ Stop'}
                    </button>
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
              scanId={scan.id}
              stage={scan.failedStage}
              message={scan.error}
              detail={scan.errorDetail}
              kind={scan.errorKind}
              running={rerunningStage !== null}
              onRetry={() => scan.failedStage && rerun([scan.failedStage])}
              onRerunAll={() => rerun(STAGES.map((s) => s.key))}
              onStop={stop}
              stopping={stopping}
            />
          )}

          {(hasScan || running) && (
            <>
              <StatCards
                scan={scan}
                stage={stage}
                running={running}
                onRun={(which) => rerun(STAGE_RERUN[which] ?? [which])}
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
                    onSearchDeeper={() => rerun(['discovery', 'buzz'], { depth: 'deep' })}
                    busy={running || rerunningStage !== null}
                  />
                )}

                {tab === 'presence' && (
                  <section>
                    <div className="rubric">
                      <h2>Sources</h2>
                      <button
                        className="rerun"
                        onClick={() => rerun(rerunStageFor('presence')!)}
                      >
                        {rerunningStage === 'presence' ? 'Running…' : '↻ Rerun'}
                      </button>
                    </div>
                    <SourcesView scan={scan} />
                  </section>
                )}

                {tab === 'discovery' && (
                  <section>
                    <div className="rubric">
                      <h2>Discovery</h2>
                      <button
                        className="rerun"
                        onClick={() => rerun(rerunStageFor('discovery')!)}
                      >
                        {rerunningStage === 'discovery' ? 'Running…' : '↻ Rerun'}
                      </button>
                      {/* Deeper, and wider.
                          The recency ladder normally stops at the first window
                          that satisfies its target, which on an active product
                          means it never looks past the last month. This walks
                          the ladder to the end and lifts the caps with it.
                          Costs several times the requests and the wall clock,
                          which is why it is a button and not the default. */}

                    </div>
                    <Buzz
                      scan={scan}
                      cursor={cursor}
                      onDig={(venue) => rerun(['discovery', 'buzz'], { dig: venue })}
                    />
                  </section>
                )}

                {tab === 'feed' && (
                  <section>
                    <div className="rubric">
                      <h2>Feed</h2>
                      <button
                        className="rerun"
                        onClick={() => rerun(rerunStageFor('feed')!)}
                      >
                        {rerunningStage === 'feed' ? 'Running…' : '↻ Rerun'}
                      </button>
                    </div>
                    <FeedView scan={scan} />
                  </section>
                )}

                {tab === 'defects' && (
                  <section>
                    <div className="rubric">
                      <h2>Defects</h2>
                      <button
                        className="rerun"
                        onClick={() => rerun(rerunStageFor('defects')!)}
                      >
                        {rerunningStage === 'health' ? 'Running…' : '↻ Rerun'}
                      </button>
                    </div>
                    <Health
                      scan={scan}
                      onChange={(issue: Issue) =>
                        setScan((s) => ({ ...s, issues: s.issues.map((i) => (i.id === issue.id ? issue : i)) }))
                      }
                      onScan={(changes) => setScan((s) => ({ ...s, ...changes }))}
                      onRerun={(stages, deep) => rerun(stages, deep ? { depth: 'deep' } : undefined)}
                      busy={running || rerunningStage !== null}
                    />
                  </section>
                )}

                {tab === 'project' && (
                  <section>
                    <div className="rubric">
                      <h2>Project</h2>
                    </div>
                    <ProjectPanel scan={scan} />
                  </section>
                )}

                {tab === 'integrity' && (
                  /* Two independent cards — the review scorecard and the
                     findings docket — which were rendering flush against each
                     other. Same shared rule as the settings, agents and outbox
                     views use. */
                  <section className="card-stack">
                    <div className="rubric">
                      <h2>Integrity</h2>
                      <button
                        className="rerun"
                        onClick={() => rerun(rerunStageFor('integrity')!)}
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
