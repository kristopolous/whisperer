import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { FixStep, Issue, Mention, Scan, Stage, Tracker } from '../../../shared/types.ts';
import { api, apiUrl, fmtAgo, fmtDate, plain, venueOf } from '../lib.ts';
import type { DefectHistory, Series } from '../../../server/series.ts';
import { Filter, matches } from './Filter.tsx';
import { ResolutionLoop } from './ResolutionLoop.tsx';

const TRACKERS: { key: Tracker; label: string }[] = [
  { key: 'linear', label: 'Linear' },
  { key: 'jira', label: 'Jira' },
  { key: 'github', label: 'GitHub' },
  { key: 'clipboard', label: 'Copy payload' },
];

const SEVERITY_ORDER: Issue['severity'][] = ['critical', 'serious', 'warning', 'good'];

/** Health is a docket: the catalogue on the left, the incident report on the
 *  right. One issue is selected at all times so the report is never an empty
 *  frame waiting for a click. */
/** What moved since the last run.
 *
 *  One line, because that is what a daily check is: the numbers themselves are
 *  already on the screen and in the rail. Absent until there is a second run to
 *  compare against — a delta of one observation is not a delta. */
function Delta({ series }: { series: Series | null }) {
  const d = series?.delta;
  if (!d) return null;

  const signed = (n: number, digits = 0) => `${n > 0 ? '+' : n < 0 ? '\u2212' : ''}${Math.abs(n).toFixed(digits)}`;
  const when = new Date(d.since).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  return (
    <div className="delta">
      since {when}:{' '}
      {d.newDefects > 0 && <b>{d.newDefects} new</b>}
      {d.newDefects > 0 && d.goneDefects > 0 && ', '}
      {d.goneDefects > 0 && <span>{d.goneDefects} gone</span>}
      {(d.newDefects > 0 || d.goneDefects > 0) && ' · '}
      mentions {signed(d.mentions)} · net {signed(d.net, 2)}
    </div>
  );
}

export function Health({ scan, onChange, onScan, onRerun, busy, patchSignal }: {
  scan: Scan;
  onChange: (issue: Issue) => void;
  onScan: (changes: Partial<Scan>) => void;
  /** Bumped when "Patch bugs" is pressed. A counter rather than a boolean so
   *  pressing it twice starts twice, which a boolean cannot express. */
  patchSignal?: number;
  /** Go and look again — from the empty state, where "nothing is wrong" and
   *  "we did not read enough" are indistinguishable from the outside. */
  onRerun?: (stages: Stage[], deep?: boolean) => void;
  busy?: boolean;
}) {
  const [query, setQuery] = useState('');
  // What this company's earlier runs said. A defect list is a snapshot; the
  // reason to look at it every morning is what moved, and that only exists
  // across runs.
  const [series, setSeries] = useState<Series | null>(null);
  useEffect(() => {
    let live = true;
    api<Series>(`api/scans/${scan.id}/series`)
      .then((data) => { if (live) setSeries(data); })
      .catch(() => {});
    return () => { live = false; };
  }, [scan.id]);
  const history: Record<string, DefectHistory> = Object.fromEntries(
    (series?.defects ?? []).filter((d) => d.state !== 'gone').map((d) => [d.id, d]),
  );

  /** What a defect's severity is worth now, as opposed to when it was written.
   *
   *  Severity is assigned once, by a model reading complaints, and then never
   *  revisited — so a "critical" sits at the top of the list forever on the
   *  strength of a week that has long passed. If it were critical and still
   *  unfixed, people would still be saying so; silence for two months is
   *  evidence about the claim, not just about the calendar.
   *
   *  Recurrence overrides age. A defect the series has seen in consecutive runs
   *  is being hit repeatedly, and that is the opposite of stale — it keeps
   *  whatever it was given no matter how long it has been going on.
   */
  const standing = (issue: Issue): { severity: Issue['severity']; why?: string } => {
    const declared = issue.severity;
    const recurring = (history[issue.id]?.streak ?? 0) > 1;
    const at = issue.lastSeen ?? issue.firstSeen;
    if (recurring || !at || declared === 'good') return { severity: declared };

    const weeks = Math.floor((Date.now() - new Date(at).getTime()) / (7 * 86_400_000));
    const steps = weeks >= 12 ? 2 : weeks >= 6 ? 1 : 0;
    if (steps === 0) return { severity: declared };

    const rank = Math.min(
      SEVERITY_ORDER.indexOf(declared) + steps,
      SEVERITY_ORDER.indexOf('warning'),
    );
    const now = SEVERITY_ORDER[rank] ?? declared;
    if (now === declared) return { severity: declared };
    return {
      severity: now,
      why: `filed ${declared}, but nobody has mentioned it in ${weeks} weeks — `
        + 'still unfixed and still quiet is evidence it is not ' + declared,
    };
  };

  // Freshest first, severity second.
  //
  // Sorting by severity alone put a critical from last spring above an outage
  // reported yesterday, which is the wrong way round for a screen somebody
  // opens to find out what is happening now — an old bug is either fixed,
  // known, or nobody cares. Severity still decides between two things reported
  // the same week, which is what it is actually good at.
  const week = (issue: Issue) => {
    const at = issue.lastSeen ?? issue.firstSeen;
    if (!at) return 0;
    return Math.floor((Date.now() - new Date(at).getTime()) / (7 * 86_400_000));
  };
  const all = [...scan.issues].sort(
    (a, b) => week(a) - week(b)
      || SEVERITY_ORDER.indexOf(standing(a).severity) - SEVERITY_ORDER.indexOf(standing(b).severity),
  );
  const issues = all.filter((i) => matches(query, i.title, i.summary, i.impact, i.kind, i.severity));
  const [selected, setSelected] = useState(issues[0]?.id);
  const issue = issues.find((i) => i.id === selected) ?? issues[0];

  /** "Patch bugs" used to switch to this tab and stop.
   *
   *  The tab was already reachable from the tab strip, so the headline control
   *  for the feature this product is named around did nothing you could not do
   *  by clicking a word. It now picks the defect worth patching first and
   *  starts on it: unfixed before fixed, critical before serious, and among
   *  equals the one with the most evidence behind it, because that is the one
   *  whose diagnosis has the most to work from.
   */
  const [autoStart, setAutoStart] = useState(0);
  useEffect(() => {
    if (!patchSignal) return;
    const rank = (i: Issue) =>
      (i.fix?.tests.passed && i.fix.provesTheBug.failedOnOriginal ? 900 : 0)
      + ({ critical: 0, serious: 1, warning: 2, good: 3 }[i.severity] ?? 4) * 10
      - Math.min(9, i.evidence.length);
    const target = [...all].sort((a, b) => rank(a) - rank(b))[0];
    if (!target) return;
    setSelected(target.id);
    setAutoStart((n) => n + 1);
  }, [patchSignal]);

  useEffect(() => { if (issues.length && !issues.some((i) => i.id === selected)) setSelected(issues[0].id); },
    [scan.id, issues.length]);

  // `all`, not `issues`. Testing the filtered list meant a search that matched
  // nothing unmounted the search box along with the rows, so there was no way
  // to clear the query that emptied the panel — and the empty state then
  // explained at length why triage had found no defects, about a run that had
  // found plenty.
  if (all.length === 0) {
    // Three different situations produce an empty list, and calling all of them
    // "nothing to fix" is a lie in two of them. Claiming a company has no
    // complaints when the triage step never executed is the worst thing this
    // panel can say, because it is both confident and wrong.
    //
    // `timings.health` is written when the stage finishes, whether it succeeded
    // or failed, so its absence is a reliable "this has not run".
    const ran = scan.timings?.health !== undefined;
    const failed = scan.failedStage === 'health';

    if (!ran) {
      return (
        <div className="panel">
          <div className="empty">
            <h3>Triage hasn't run yet</h3>
            <p>
              This scan stopped at <b>{scan.stage}</b>, so nothing has been read for complaints. This
              is not a finding about {scan.company} — it is a run that did not get this far. Use
              <b> ↻ Rerun</b> above to triage the {scan.mentions.length} mention
              {scan.mentions.length === 1 ? '' : 's'} already collected.
            </p>
          </div>
        </div>
      );
    }

    if (failed) {
      return (
        <div className="panel">
          <div className="empty">
            <h3>Triage failed</h3>
            <p>{scan.error ?? 'The triage step errored, so no issues were produced. Rerun it above.'}</p>
          </div>
        </div>
      );
    }

    if (scan.mentions.length === 0) {
      return (
        <div className="panel">
          <div className="empty">
            <h3>Nothing to triage</h3>
            <p>
              Discovery returned no third-party discussion, so triage had nothing to read. The gap is
              upstream of this tab — rerun discovery first.
            </p>
          </div>
        </div>
      );
    }

    const complaints = scan.mentions.filter((m) => m.complaint).length;
    return (
      <div className="panel">
        <div className="empty">
          <h3>No defects found in {scan.mentions.length} mentions</h3>
          <p>
            Nothing triage read pointed at a reproducible defect
            {complaints > 0
              ? ` — though ${complaints} mention${complaints === 1 ? '' : 's'} read as a complaint, `
                + 'which is worth disbelieving this for.'
              : '.'}
          </p>
          {/* The action, not just the caveat. "Worth a second look" with no way
              to take one is a shrug — and triage runs on what discovery
              collected, so looking again means widening that first. */}
          <div className="actions">
            <button className="primary" disabled={busy} onClick={() => onRerun?.(['health'])}>
              {busy ? 'Reading…' : 'Read the complaints again'}
            </button>
            <button className="ghost" disabled={busy} onClick={() => onRerun?.(['discovery', 'buzz', 'health'], true)}>
              ⤓ Search wider, then triage
            </button>
          </div>
        </div>
      </div>
    );
  }

  /** How far along the loop a defect is.
   *
   *  The list was 328 rows in one column with nothing separating them, so a
   *  defect somebody had diagnosed, patched, filed and replied to sat between
   *  two nobody had opened, wearing the same tags. The whole product is the
   *  loop; the list has to say where each thing is in it.
   *
   *  Ordered by what needs a person, not by how much has been done: untouched
   *  work is the backlog, work waiting on us is the queue, work waiting on
   *  somebody else is a reminder, and closed is history. */
  const PHASES = [
    { key: 'acting', label: 'Worked on', hint: 'Diagnosed, patched or filed — not yet answered' },
    { key: 'waiting', label: 'Waiting on the reporter', hint: 'We replied; they have not come back' },
    { key: 'open', label: 'Not started', hint: 'Nobody has opened these yet' },
    { key: 'closed', label: 'Closed', hint: 'The reporter confirmed it' },
  ] as const;

  const phaseOf = (i: Issue): typeof PHASES[number]['key'] => {
    if (i.loop?.some((e) => e.step === 'closed')) return 'closed';
    // Told them, not heard back. `outreach` and `fix-notified` are the two
    // steps that put the ball in the reporter's court; `confirmed` means it
    // came back and is on its way to closed.
    if (i.loop?.some((e) => e.step === 'outreach' || e.step === 'fix-notified')
      && !i.loop.some((e) => e.step === 'confirmed')) return 'waiting';
    if (i.diagnosis || i.fix || i.filedTo || (i.loop?.length ?? 0) > 0) return 'acting';
    return 'open';
  };

  const grouped = PHASES
    .map((phase) => ({ phase, rows: issues.filter((i) => phaseOf(i) === phase.key) }))
    .filter((group) => group.rows.length > 0);

  return (
    <div className="panel">
      <WriteTarget scan={scan} onScan={onScan} />
      <div className="docket">
        {/* An absolutely-positioned scroller inside a plain grid item.
            This is the only way a grid column can be exactly as tall as its
            neighbour without either one bounding the other: the list's own
            content is taken out of flow, so it contributes nothing to the row
            height, the row is sized by the report alone, and the scroller
            stretches to fill whatever that turns out to be. Capping the list at
            a fixed height leaves dead space; letting it size itself makes a
            328-row list set the height of the page. */}
        <div className="docket-list">
        <div className="docket-scroll" role="listbox" aria-label="Issue catalogue">
          <Delta series={series} />
          <Filter
            value={query}
            onChange={setQuery}
            placeholder="Search issues…"
            showing={issues.length}
            total={all.length}
          />
          {issues.length === 0 && <div className="dash-empty">Nothing matches “{query}”.</div>}
          {grouped.map((group) => (
            <Fragment key={group.phase.key}>
              {/* Sticky, because these lists run to hundreds and a heading that
                  scrolls away leaves you reading rows with no idea which group
                  you are in. */}
              <div className="docket-group" title={group.phase.hint}>
                <span>{group.phase.label}</span>
                <span className="docket-group-n">{group.rows.length}</span>
              </div>
              {group.rows.map((i) => (
            <button
              key={i.id}
              className="docket-row"
              data-phase={group.phase.key}
              aria-current={i.id === issue.id}
              onClick={() => setSelected(i.id)}
            >
              <div className="t">{i.title}</div>
              <div className="m">
                {(() => {
                  const now = standing(i);
                  return (
                    <span className={`tag ${now.severity}`} title={now.why ?? i.severity}>
                      {now.severity}
                      {now.why && <span className="tag-was">was {i.severity}</span>}
                    </span>
                  );
                })()}
                <span className="tag plain">{i.kind}</span>
                {/* When, before how many. On a terminal the age is the first
                    thing worth knowing about a defect. */}
                <span style={{ font: '400 10.5px var(--mono)', color: 'var(--ink-3)' }}>
                  {/* When the complaint was made. Not when we ran a scan —
                      that says nothing about the defect, and printing it in
                      this slot dressed a failed date parse up as a fact. */}
                  {fmtAgo(i.lastSeen ?? i.firstSeen) ?? 'no date'} · {i.evidence.length}
                </span>
                {/* How long this has been true, which is the only thing on the
                    row that a second run can tell you and a first cannot. */}
                {history[i.id]?.state === 'new' && <span className="tag warning">new</span>}
                {(history[i.id]?.streak ?? 0) > 1 && (
                  <span className="tag plain">{history[i.id]!.streak} runs running</span>
                )}
                {/* The loop's own state, told apart from severity by shape as
                    well as colour: severity tags are filled, these are outlined,
                    so a row that has been worked does not read as a row that is
                    merely serious. */}
                {group.phase.key === 'closed' && <span className="tag step done">closed by reporter</span>}
                {group.phase.key === 'waiting' && <span className="tag step waiting">awaiting reporter</span>}
                {group.phase.key === 'acting' && (
                  <span className="tag step acting">
                    {i.fix ? 'patched' : i.filedTo ? `filed to ${i.filedTo.tracker}` : 'diagnosed'}
                  </span>
                )}
              </div>
            </button>
              ))}
            </Fragment>
          ))}
        </div>
        </div>
        <Report scan={scan} issue={issue} onChange={onChange} onScan={onScan} autoStart={autoStart} />
      </div>
    </div>
  );
}

/** The mentions an issue was built from, resolved against the scan.
 *
 *  The ids that resolved to nothing are returned too. An issue cites mention
 *  ids; if one is not in the corpus there is no link to give, and rendering one
 *  fewer row without saying so makes an unsupported claim look identical to a
 *  supported one. */
function sourcesFor(scan: Scan, issue: Issue) {
  const found: Mention[] = [];
  const missing: string[] = [];
  for (const id of issue.evidence) {
    const mention = scan.mentions.find((m) => m.id === id);
    if (mention) found.push(mention);
    else missing.push(id);
  }
  return { found, missing };
}

/** Where a defect came from: the links, directly under its title.
 *
 *  Links and nothing else. Every issue here is a model's reading of what
 *  strangers wrote, and checking that reading means opening the thread — so
 *  what this owes the reader is the URL. Venue, author, engagement, score and
 *  themes all sat here at one point and were furniture: none of them is
 *  evidence that the link is good, and all of them cost attention on the way
 *  to it. */
function Provenance({ scan, issue }: { scan: Scan; issue: Issue }) {
  const { found, missing } = sourcesFor(scan, issue);

  return (
    <div className="prov">
      <h5>Source</h5>
      <ul className="prov-list">
        {found.map((m) => (
          <li key={m.id}>
            <a href={m.url} target="_blank" rel="noreferrer">{m.url}</a>
          </li>
        ))}
        {found.length === 0 && <li className="q">No source in this scan can be opened for this.</li>}
      </ul>
      {missing.length > 0 && found.length > 0 && (
        <p className="q">
          {missing.length} cited {missing.length === 1 ? 'source is' : 'sources are'} not in this scan.
        </p>
      )}
    </div>
  );
}

interface ProjectCode {
  state: 'workspace' | 'specified' | 'discovered' | 'declared-none' | 'unknown';
  at?: string;
  why: string;
}

/** Where the code is, stated and changeable.
 *
 *  This is a setting, not a readout. What the resolve step found is a
 *  suggestion — for a closed product it routinely finds something adjacent, and
 *  bolt.new resolves to `stackblitz/bolt.new`, which exists, is public, and is
 *  not the product people are complaining about. Offering to read that is worse
 *  than offering nothing, because the diagnosis comes back confident.
 *
 *  So the guess is shown as a guess, in the place where the action is, with
 *  every alternative next to it: point it somewhere else, point it at a local
 *  checkout, or say there is no source. All three are answers, and all three
 *  are remembered against the company so nothing re-guesses next run.
 */
function CodeSource({ scan, onScan }: { scan: Scan; onScan: (changes: Partial<Scan>) => void }) {
  const [code, setCode] = useState<ProjectCode | null>(null);
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ code: ProjectCode }>(`api/scans/${scan.id}/project`)
      .then((p) => setCode(p.code))
      .catch(() => {});
  }, [scan.id]);
  useEffect(load, [load, scan.workspace]);

  const save = async (changes: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const p = await api<{ code: ProjectCode }>(`api/scans/${scan.id}/project`, {
        method: 'PUT', body: JSON.stringify(changes),
      });
      setCode(p.code);
      setEditing(false);
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, '').slice(0, 200));
    } finally {
      setBusy(false);
    }
  };

  if (!code) return null;

  const LABEL: Record<ProjectCode['state'], string> = {
    workspace: 'a local checkout',
    specified: 'the repository you set',
    discovered: 'a guess',
    'declared-none': 'no source',
    unknown: 'not known',
  };

  return (
    <div className={`codesrc${code.state === 'discovered' ? ' unconfirmed' : ''}`}>
      <div className="codesrc-head">
        <strong>Source code</strong>
        <span className={`tag ${code.state === 'declared-none' || code.state === 'unknown' ? 'warning' : code.state === 'discovered' ? 'plain' : 'good'}`}>
          {LABEL[code.state]}
        </span>
        {!editing && (
          <button className="ghost" onClick={() => { setEditing(true); setUrl(code.at ?? ''); }}>
            Change
          </button>
        )}
      </div>

      {code.at
        ? <div className="codesrc-at"><code>{code.at}</code></div>
        : null}
      <p className="q">{code.why}</p>

      {/* A guess is offered for confirmation rather than acted on. One click
          makes it the answer and it stops being re-derived every run. */}
      {code.state === 'discovered' && !editing && (
        <div className="actions">
          <button className="primary" disabled={busy} onClick={() => save({ url: code.at })}>
            Yes, that is this product
          </button>
          <button className="ghost" disabled={busy} onClick={() => save({ noSource: true, url: '' })}>
            No — closed source
          </button>
        </div>
      )}

      {code.state === 'declared-none' && !editing && (
        <div className="actions">
          <button className="ghost" disabled={busy} onClick={() => save({ noSource: false })}>
            Undo — there is source after all
          </button>
        </div>
      )}

      {editing && (
        <div className="actions">
          <input
            className="conn-url"
            value={url}
            spellCheck={false}
            placeholder="https://github.com/owner/repo"
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void save({ url: url.trim(), noSource: false }); }}
          />
          <button className="primary" disabled={busy} onClick={() => save({ url: url.trim(), noSource: false })}>
            Save
          </button>
          <button className="ghost" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
          <button className="ghost" disabled={busy} onClick={() => save({ noSource: true, url: '' })}>
            There is no source
          </button>
        </div>
      )}

      {error && <p className="conn-err">{error}</p>}
      <WorkspacePicker scan={scan} onScan={onScan} />
    </div>
  );
}

interface Payload { tracker: Tracker; title: string; body: string; labels: string[]; endpoint: string }

function Report({ scan, issue, onChange, onScan, autoStart }: {
  scan: Scan; issue: Issue; onChange: (issue: Issue) => void; onScan: (changes: Partial<Scan>) => void;
  /** Bumped by "Patch bugs" to start this defect's investigation without a
   *  second click. Zero on every other render, so nothing starts by accident. */
  autoStart?: number;
}) {
  const [fileError, setFileError] = useState<string | null>(null);
  const [pr, setPr] = useState<{ number: number; url: string } | null>(null);
  const [opening, setOpening] = useState(false);
  const [prError, setPrError] = useState<string | null>(null);
  const [payload, setPayload] = useState<Payload | null>(null);
  const [busy, setBusy] = useState(false);

  // Reading the source and patching it are minutes of model time, so the state
  // here is per-issue and the buttons say which phase they are in rather than
  // just spinning.
  const [working, setWorking] = useState<'diagnose' | 'fix' | null>(null);
  const [steps, setSteps] = useState<{ step: string; note: string }[]>([]);
  const [investigating, setInvestigating] = useState(false);
  const busyNow = working !== null || investigating;

  /** Fork, clone, read, patch, publish — streamed, so the wait is legible. */
  const investigate = useCallback(() => {
    setSteps([]);
    setSourceError(null);
    setInvestigating(true);
    const stream = new EventSource(apiUrl(`api/scans/${scan.id}/issues/${issue.id}/investigate/stream`));
    stream.onmessage = (message) => {
      const event = JSON.parse(message.data) as
        { type: 'log'; line: { text: string } } | { type: 'done'; scan: Scan } | { type: 'error'; message: string };
      if (event.type === 'log') {
        const m = event.line.text.match(/^\[(\w+)\]\s*(.*)$/);
        if (m) setSteps((prev) => [...prev, { step: m[1]!, note: m[2] ?? '' }]);
      }
      if (event.type === 'done') {
        const fresh = event.scan.issues.find((i) => i.id === issue.id);
        if (fresh) onChange(fresh);
        onScan({ fork: event.scan.fork });
        setInvestigating(false);
        stream.close();
      }
      if (event.type === 'error') {
        setSourceError(event.message);
        setInvestigating(false);
        stream.close();
      }
    };
    stream.onerror = () => { setInvestigating(false); stream.close(); };
  }, [scan.id, issue.id, onChange, onScan]);

  // Started by "Patch bugs". Guarded on the counter so it fires once per press
  // and never on an ordinary render.
  const started = useRef(0);
  useEffect(() => {
    if (!autoStart || autoStart === started.current) return;
    started.current = autoStart;
    investigate();
  }, [autoStart, investigate]);

  const [sourceError, setSourceError] = useState<string | null>(null);
  const [repos, setRepos] = useState<{ company: string }[] | null>(null);

  useEffect(() => {
    api<{ company: string }[]>('api/repos').then(setRepos).catch(() => setRepos([]));
  }, []);

  // Diagnosis needs a checkout, and which repository belongs to a company is
  // configuration rather than something to guess at. Without one the buttons
  // say so instead of failing when pressed.
  // Either configured, or worked out from what was typed in — pasting a repo
  // URL should be enough to get a diagnosis without also editing a config file.
  const hasRepo = Boolean(scan.workspace)
    || Boolean(scan.subject?.repo)
    || (repos ?? []).some((r) => r.company.toLowerCase() === scan.company.trim().toLowerCase());

  /** Read the source, then patch it, in one go.
   *
   *  The two-button version made you diagnose, read a verdict, and then press
   *  a second button that was disabled until you had. That is the machine's
   *  sequencing showing through the UI: what a person wants is "try to fix
   *  this", and diagnosis is a step on the way, not a decision to make. */
  const tryToFix = async () => {
    setSourceError(null);
    try {
      let current = issue;
      if (!current.diagnosis) {
        setWorking('diagnose');
        const d = await api<{ diagnosis: Issue['diagnosis'] }>(
          `api/scans/${scan.id}/issues/${issue.id}/diagnose`, { method: 'POST', body: '{}' },
        );
        current = { ...current, diagnosis: d.diagnosis };
        onChange(current);
      }

      setWorking('fix');
      const f = await api<{ fix: Issue['fix'] }>(
        `api/scans/${scan.id}/issues/${issue.id}/fix`, { method: 'POST', body: '{}' },
      );
      onChange({ ...current, fix: f.fix });
    } catch (error) {
      setSourceError(String(error).replace(/^Error:\s*/, '').slice(0, 300));
    } finally {
      setWorking(null);
    }
  };

  const runSource = async (which: 'diagnose' | 'fix') => {
    setWorking(which);
    setSourceError(null);
    try {
      const result = await api<{ diagnosis?: Issue['diagnosis']; fix?: Issue['fix'] }>(
        `api/scans/${scan.id}/issues/${issue.id}/${which}`, { method: 'POST', body: '{}' },
      );
      onChange({ ...issue, ...(result.diagnosis ? { diagnosis: result.diagnosis } : {}), ...(result.fix ? { fix: result.fix } : {}) });
    } catch (error) {
      setSourceError(String(error).replace(/^Error:\s*/, '').slice(0, 300));
    } finally {
      setWorking(null);
    }
  };

  /* Hydrate the preview as soon as an issue is selected. Building a payload is
   * local and sends nothing anywhere, so making someone click a tracker just to
   * see what would be filed is a click for nothing — prefill it with whatever
   * tracker the issue already went to, or the clipboard default. A failure here
   * is not worth an error state: the tracker buttons still fetch on demand. */
  useEffect(() => {
    let live = true;
    setPayload(null);
    api<Payload>(`api/scans/${scan.id}/issues/${issue.id}/payload`, {
      method: 'POST', body: JSON.stringify({ tracker: issue.filedTo?.tracker ?? 'clipboard' }),
    })
      .then((p) => { if (live) setPayload(p); })
      .catch(() => {});
    return () => { live = false; };
  }, [scan.id, issue.id]);

  /** Draft the reply and put it in the outbox. Never sends: `send` is not
   *  passed, so this produces something to read and approve, which is the only
   *  thing that should happen without a person looking at it. */
  const [reply, setReply] = useState<{ message: string; destination: string } | null>(null);
  const sendReply = async (phase: 'acknowledge' | 'fix-notify') => {
    setBusy(true);
    setFileError(null);
    try {
      const result = await api<{ draft: { message: string; destination: string } }>(
        `api/scans/${scan.id}/issues/${issue.id}/reply`,
        { method: 'POST', body: JSON.stringify({ phase }) },
      );
      setReply(result.draft);
    } catch (error) {
      setFileError(String(error).replace(/^Error:\s*/, '').slice(0, 300));
    } finally { setBusy(false); }
  };

  const preview = async (tracker: Tracker) => {
    setBusy(true);
    try {
      setPayload(await api<Payload>(`api/scans/${scan.id}/issues/${issue.id}/payload`, {
        method: 'POST', body: JSON.stringify({ tracker }),
      }));
    } finally { setBusy(false); }
  };

  /** File it — which for GitHub now means actually filing it.
   *
   *  The other trackers still only record that a person filed it by hand, and
   *  the button says which of the two is happening. Marking an issue "filed"
   *  when nothing was sent is the kind of lie this panel exists to prevent, so
   *  a GitHub attempt that is refused (no fork, no token) reports the refusal
   *  rather than quietly falling back to the marker. */
  const file = async () => {
    if (!payload) return;
    setBusy(true);
    setFileError(null);
    try {
      if (payload.tracker === 'github') {
        const result = await api<{ filed: boolean; reason: string; issue: Issue }>(
          `api/scans/${scan.id}/issues/${issue.id}/ticket`,
          { method: 'POST', body: JSON.stringify({ tracker: 'github', submit: true }) },
        );
        if (!result.filed) { setFileError(result.reason); return; }
        onChange(result.issue);
        return;
      }

      if (payload.tracker === 'clipboard') {
        await navigator.clipboard.writeText(`${payload.title}\n\n${payload.body}`);
      }
      onChange(await api(`api/scans/${scan.id}/issues/${issue.id}/file`, {
        method: 'POST', body: JSON.stringify({ tracker: payload.tracker }),
      }));
    } catch (error) {
      setFileError(String(error).replace(/^Error:\s*/, '').slice(0, 300));
    } finally { setBusy(false); }
  };

  return (
    <div className="report">
      <h4>{issue.title}</h4>
      <div className="meta">
        <span className={`tag ${issue.severity}`}>{issue.severity}</span>
        <span className="tag plain">{issue.kind}</span>
        <span style={{ font: '400 11px var(--mono)', color: 'var(--ink-3)' }}>
          {issue.firstSeen
            ? `reported on ${fmtDate(issue.firstSeen)}`
            /* Named as our failure, against the pages it failed on, because
               that is what it is: every one of these has a URL we fetched, and
               the date is on it. */
            : `no date could be read from ${issue.evidence.length} source${issue.evidence.length === 1 ? '' : 's'}`}
          {issue.lastSeen && issue.lastSeen !== issue.firstSeen ? ` · last ${fmtDate(issue.lastSeen)}` : ''}
        </span>
        {issue.filedTo && (
          <span className="tag good">filed to {issue.filedTo.tracker}</span>
        )}
      </div>

      <Provenance scan={scan} issue={issue} />

      <CodeSource scan={scan} onScan={onScan} />
      
      {issue.diagnosis && <DiagnosisView diagnosis={issue.diagnosis} />}
      {issue.fix && <FixView fix={issue.fix} />}

      {issue.fix && (
        <>
          {/* A pull request is only offered for a patch that earned one. A
              green suite on a test that never failed proves nothing, and
              opening a PR on the strength of it is how a wrong fix gets
              merged — so the button is not there to be pressed hopefully. */}
          {!issue.fix.tests.passed ? (
            <p className="q">
              The suite did not pass on this patch, so there is no pull request to open. Try again, or
              read the failure above.
            </p>
          ) : !scan.fork ? (
            <p className="q">
              Fork the project first — the button is at the top of this panel. Every pull request this
              writes goes to your own fork, never to {scan.company}.
            </p>
          ) : (
            <>
              <div className="actions">
                <button
                  className="primary"
                  disabled={opening || Boolean(pr)}
                  onClick={async () => {
                    setOpening(true);
                    setPrError(null);
                    try {
                      const result = await api<{ pr: { number: number; url: string }; issue: Issue }>(
                        `api/scans/${scan.id}/issues/${issue.id}/pr`, { method: 'POST', body: '{}' },
                      );
                      setPr(result.pr);
                      onChange(result.issue);
                    } catch (error) {
                      setPrError(String(error).replace(/^Error:\s*/, '').slice(0, 300));
                    } finally { setOpening(false); }
                  }}
                >
                  {opening ? 'Opening…' : pr ? `Opened #${pr.number}` : `Open a pull request on ${scan.fork}`}
                </button>
                {pr && <a className="conn-meta" href={pr.url} target="_blank" rel="noreferrer">view it</a>}
              </div>
              <p className="q">
                Commits the patched files to a new branch on <code>{scan.fork}</code> and opens the pull
                request against that fork's own default branch. The upstream project is not touched and
                is never notified.
              </p>
              {prError && <p className="conn-err">{prError}</p>}
            </>
          )}
        </>
      )}

      <p>{plain(issue.summary)}</p>

      <h5>Impact</h5>
      <p>{plain(issue.impact)}</p>

      {/* The test that decides it, shown at the same level as the impact —
          because it is what makes the impact a claim rather than an opinion,
          and it is the acceptance criterion every downstream step is measured
          against. */}
      <h5>How to tell</h5>
      {issue.check && !/^cannot be derived/i.test(issue.check)
        ? <p className="check">{plain(issue.check)}</p>
        : (
          <p className="q check-none">
            {issue.check
              ? 'No falsifiable test could be derived from what people wrote. Until there is one, '
                + 'there is nothing to confirm and nothing to verify a fix against — so the source '
                + 'is not worth opening for this yet.'
              : 'This issue was catalogued before reproduction tests existed. Re-run triage to '
                + 'give it one.'}
          </p>
        )}

      {/* The ladder is the call to action.
          Its `next` rung is by definition the next thing that will be done, so
          the button belongs on it — not in a separate panel above that said the
          same thing louder. */}
      <ResolutionLoop
        issue={issue}
        busy={busyNow || busy}
        progress={(busyNow || steps.length > 0 || sourceError) ? (
          <>
            {(busyNow || steps.length > 0) && (
              <ol className="steps-run">
                {STEP_ORDER.map((key) => {
                  const hit = steps.find((step) => step.step === key);
                  const last = steps.at(-1)?.step === key;
                  // The step that died is the last one reached. Without this
                  // every step rendered as done and the error sat under the
                  // whole ladder, so the one thing the list is for — saying how
                  // far it got — was the one thing it did not say.
                  const state = !hit ? 'idle'
                    : last && sourceError ? 'failed'
                      : last && busyNow ? 'active'
                        : 'done';
                  return (
                    <li key={key} className="steps-run-item" data-state={state}>
                      <span className="steps-run-dot" />
                      <span className="steps-run-label">{STEP_LABEL[key]}</span>
                      {hit?.note && state === 'active' && <span className="conn-meta">{hit.note}</span>}
                      {state === 'failed' && <span className="conn-err">{sourceError}</span>}
                    </li>
                  );
                })}
              </ol>
            )}
            {/* Only when no step owns it — an error during forking belongs on
                the forking row, not repeated under the list. */}
            {sourceError && steps.length === 0 && <p className="conn-err">{sourceError}</p>}
          </>
        ) : null}
        onAction={(action) => {
          if (action === 'investigate') return investigate();
          if (action === 'diagnose') return void runSource('diagnose');
          if (action === 'file') return void preview('github');
          // Filing first is enforced by the ladder, so by the time this fires
          // there is a ticket for the reply to hand over.
          return void sendReply(action === 'reply' ? 'acknowledge' : 'fix-notify');
        }}
      />

      <h5>Reply to the people who raised it</h5>
      {/* The drafted reply once one has been asked for, because it carries the
          real ticket link and the triage-time draft cannot. Nothing is sent
          from here — it goes to the outbox to be read first. */}
      {reply
        ? (
          <>
            <p className="reply">{reply.message}</p>
            <p className="conn-meta">Would go to: {reply.destination}. Nothing has been sent.</p>
          </>
        )
        : <p className="reply">{issue.draftReply}</p>}

      <h5>File it</h5>
      <div className="actions">
        {TRACKERS.map((t) => (
          <button
            key={t.key}
            onClick={() => preview(t.key)}
            disabled={busy}
            style={payload?.tracker === t.key ? { borderColor: 'var(--signal)', color: 'var(--signal)' } : undefined}
          >
            {t.label}
          </button>
        ))}
      </div>

      {payload && (
        <>
          <pre className="payload">{`# ${payload.title}\nlabels: ${payload.labels.join(', ')}\nvia: ${payload.endpoint}\n\n${payload.body}`}</pre>
          <div className="actions">
            <button className="primary" onClick={file} disabled={busy}>
              {busy && payload.tracker === 'github' ? 'Writing the ticket…'
                : payload.tracker === 'clipboard' ? 'Copy and mark filed'
                  : payload.tracker === 'github' ? `File on ${scan.fork ?? 'your fork'}`
                    : `Send to ${payload.tracker}`}
            </button>
            <button onClick={() => setPayload(null)}>Discard</button>
          </div>
          {fileError && <p className="conn-err">{fileError}</p>}
          {payload.tracker === 'github' && (
            <div className="notice ok" style={{ marginTop: 10 }}>
              <span className="tag good">this one really files</span>
              <span>
                The ticket is rewritten from what the reporters actually wrote — repro steps,
                expected and actual — and opened on your fork, with the audit header saying who
                raised it and whether they have been contacted. Every later step of the loop is
                appended to it as a comment.
              </span>
            </div>
          )}
          {payload.tracker !== 'clipboard' && payload.tracker !== 'github' && (
            <div className="notice" style={{ marginTop: 10 }}>
              <span className="tag warning">not connected</span>
              <span>
                No {payload.tracker} connector is registered yet, so this marks the issue filed and
                keeps the payload rather than sending it. Add the connector in <code>src/registry.ts</code>
                and it goes out for real.
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const VERDICT_TONE: Record<NonNullable<Issue['diagnosis']>['verdict'], string> = {
  located: 'good',
  plausible: 'warning',
  insufficient: 'plain',
  'not-a-defect': 'plain',
};

const VERDICT_MEANS: Record<NonNullable<Issue['diagnosis']>['verdict'], string> = {
  located: 'the code path that produces this was identified',
  plausible: 'the code is consistent with the report but does not pin it',
  insufficient: 'what was read does not cover the reported behaviour',
  'not-a-defect': 'this describes the software working as designed',
};

/** What reading the source concluded.
 *
 *  `insufficient` is shown as plainly as `located`, deliberately. It is the
 *  correct answer most of the time — a text search over a large codebase lands
 *  near a subsystem, not on a defect — and dressing it up as a failure would
 *  push toward a confident wrong file, which sends an engineer somewhere there
 *  is nothing to find and gets a real bug closed as unreproducible. */
function DiagnosisView({ diagnosis }: { diagnosis: NonNullable<Issue['diagnosis']> }) {
  return (
    <div className="source-result">
      <div className="source-head">
        <span className={`tag ${VERDICT_TONE[diagnosis.verdict]}`}>{diagnosis.verdict}</span>
        <span className="conn-meta">{diagnosis.confidence} confidence</span>
        <span className="agent-desc">{VERDICT_MEANS[diagnosis.verdict]}</span>
      </div>

      <dl className="agent-detail">
        <dt>likely cause</dt><dd>{diagnosis.likelyCause}</dd>
        <dt>proposed fix</dt><dd>{diagnosis.proposedFix}</dd>
        <dt>test to add</dt><dd>{diagnosis.regressionTest}</dd>
      </dl>

      <h6>Files to open</h6>
      <ul className="evidence">
        {diagnosis.suspectFiles.map((f) => (
          <li key={f.path}><code>{f.path}</code><div className="q">{f.why}</div></li>
        ))}
      </ul>

      {diagnosis.unknowns.length > 0 && (
        <>
          <h6>What it could not establish</h6>
          <ul className="evidence">
            {diagnosis.unknowns.map((u) => <li key={u} className="q">{u}</li>)}
          </ul>
        </>
      )}

      <p className="q">
        Searched {diagnosis.searched.hits} matching lines across {diagnosis.searched.files.length} files
        for: {diagnosis.searched.terms.slice(0, 8).join(', ')}
      </p>
    </div>
  );
}

/** The patch, and whether it is worth anything.
 *
 *  Two facts carry the weight here and neither is the diff. Did the suite pass;
 *  and did the new regression test FAIL against the original code. A test that
 *  passes before and after has tested nothing, and a green suite on top of it
 *  is the most convincing way this whole pipeline can be wrong. */
function FixView({ fix }: { fix: NonNullable<Issue['fix']> }) {
  const proven = fix.provesTheBug.checked && fix.provesTheBug.failedOnOriginal;

  return (
    <div className="source-result">
      <div className="source-head">
        <span className={`tag ${fix.tests.passed ? 'good' : 'critical'}`}>
          {fix.tests.passed ? 'tests pass' : 'tests fail'}
        </span>
        <span className={`tag ${proven ? 'good' : 'warning'}`}>
          {proven ? 'catches the bug' : fix.provesTheBug.checked ? 'proves nothing' : 'unproven'}
        </span>
        <span className="conn-meta">
          {fix.attempts} attempt{fix.attempts === 1 ? '' : 's'} · {fix.files.length} file
          {fix.files.length === 1 ? '' : 's'}
        </span>
      </div>

      <p className="q">{fix.summary}</p>
      {!proven && <p className="conn-err">{fix.provesTheBug.detail}</p>}

      {/* The baseline, first. Everything below it is read differently
          depending on whether the suite was green before anything was touched. */}
      {fix.baseline && (
        <p className={fix.baseline.passed ? 'q' : 'conn-err'}>
          <b>Before any change:</b> {fix.baseline.note}
        </p>
      )}

      {(fix.trail?.length ?? 0) > 0 && <WorkLog trail={fix.trail!} />}

      <dl className="agent-detail">
        <dt>tests</dt><dd><code>{fix.tests.command}</code></dd>
        <dt>working copy</dt><dd><code>{fix.workdir}</code> — nothing was committed or pushed</dd>
      </dl>

      {fix.diff && <pre className="payload">{fix.diff.slice(0, 6000)}</pre>}
      {!fix.tests.passed && <pre className="payload">{fix.tests.output.slice(0, 2000)}</pre>}
      {fix.notes && <p className="q">{fix.notes}</p>}
    </div>
  );
}

/** Where anything this panel writes will land.
 *
 *  This band exists because the answer is not obvious and getting it wrong is
 *  the one unrecoverable mistake here. Filing a model-written ticket, or
 *  opening a model-written pull request, on somebody else's project wastes a
 *  maintainer's afternoon and cannot be undone by deleting it — they have
 *  already read it. So the destination is stated before either action is
 *  offered, in the same place the actions are.
 *
 *  The write path refuses a repository the token does not own regardless of
 *  what this says (see channels/fork.ts). This is the part that means you never
 *  have to find that out by being refused.
 */
function WriteTarget({ scan, onScan }: { scan: Scan; onScan: (changes: Partial<Scan>) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upstream = scan.subject?.repo;
  if (!upstream) return null;

  const short = upstream.replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\.git$/, '');

  if (scan.fork) {
    return (
      <div className="notice ok">
        <span className="tag good">writing to your fork</span>
        <span>
          Tickets and pull requests go to{' '}
          <a href={`https://github.com/${scan.fork}`} target="_blank" rel="noreferrer"><code>{scan.fork}</code></a>,
          a fork of <code>{short}</code>. The project itself is never written to.
        </span>
      </div>
    );
  }

  return (
    <div className="notice">
      {/* Says what to do, not what is wrong. "nowhere to file" and "no write
          access" both describe a state and leave the reader to work out the
          action; the action is the only reason this notice exists. */}
      <span className="tag warning">fork to file tickets</span>
      {/* Names what gets copied and where it lands.
          "fork it" beside a button reading "Fork it" said the same word twice
          and neither said what would be forked, or into whose account, or what
          changes afterwards. A button that creates a repository under somebody's
          own login should say so before it is pressed. */}
      <span><code>{short}</code> is not yours to write to.</span>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const result = await api<{ fork: { fullName: string } }>(
              `api/scans/${scan.id}/fork`, { method: 'POST', body: '{}' },
            );
            onScan({ fork: result.fork.fullName });
          } catch (e) {
            setError(String(e).replace(/^Error:\s*/, '').slice(0, 300));
          } finally { setBusy(false); }
        }}
      >
        {busy ? `Forking ${short}…` : `Fork ${short} to your account`}
      </button>
      {error && <span className="conn-err">{error}</span>}
    </div>
  );
}

interface WorkspaceRow { name: string; remote: string | null; branch: string | null; updated: string | null }

/** Choose which checkout to diagnose against.
 *
 *  This is the answer for closed source, and the shape of it is the point:
 *  there is no field here for a repository URL and no field for a key. Somebody
 *  with access clones the private repository into the workspace directory
 *  themselves, using their own credentials — which is also the only thing that
 *  works when the key has a passphrase on it — and this list is what showed up.
 *  Nothing this app stores can reach anybody's source.
 */
function WorkspacePicker({ scan, onScan }: { scan: Scan; onScan: (changes: Partial<Scan>) => void }) {
  const [data, setData] = useState<{ root: string; workspaces: WorkspaceRow[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = () => api<{ root: string; workspaces: WorkspaceRow[] }>('api/workspaces')
    .then(setData).catch(() => setData(null));
  useEffect(() => { void load(); }, []);

  const choose = async (name: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ workspace: string | null }>(`api/scans/${scan.id}/workspace`, {
        method: 'POST', body: JSON.stringify({ workspace: name }),
      });
      onScan({ workspace: result.workspace ?? undefined });
      setOpen(false);
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, '').slice(0, 300));
    } finally { setBusy(false); }
  };

  if (scan.workspace) {
    const row = data?.workspaces.find((w) => w.name === scan.workspace);
    return (
      <div className="notice ok" style={{ marginBottom: 12 }}>
        <span className="tag good">local checkout</span>
        <span>
          Reading <code>{scan.workspace}</code>
          {row?.remote ? <> — <span className="q">{row.remote}</span></> : null}
          {row?.branch ? <> on <code>{row.branch}</code></> : null}
          . Nothing is cloned or fetched, and no credential for this repository is stored here.
        </span>
        <button disabled={busy} onClick={() => choose('')}>Use something else</button>
      </div>
    );
  }

  const rows = data?.workspaces ?? [];

  return (
    <div style={{ marginBottom: 12 }}>
      <div className="actions">
        <button onClick={() => { setOpen(!open); if (!open) void load(); }}>
          {open ? 'Cancel' : 'Use a local checkout…'}
        </button>
      </div>

      {open && (
        <div className="conn-detail">
          {rows.length === 0 ? (
            <p className="q">
              The workspace is empty. Clone the repository into it with your own credentials — this
              app never sees them, which is also the only thing that works when the key has a
              passphrase:
              <br />
              <code>git clone &lt;your-private-repo&gt; {data?.root ?? '<workspace>'}/&lt;name&gt;</code>
              <br />
              Then reopen this list.
            </p>
          ) : (
            <>
              <p className="q">
                Checkouts found in <code>{data?.root}</code>. Only this directory is readable — a
                name that points anywhere else is refused.
              </p>
              <ul className="evidence">
                {rows.map((w) => (
                  <li key={w.name}>
                    <button className="ghost conn-link" disabled={busy} onClick={() => choose(w.name)}>
                      <code>{w.name}</code>
                    </button>
                    <div className="q">
                      {w.remote ?? 'no origin remote'}
                      {w.branch ? ` · ${w.branch}` : ''}
                      {w.updated ? ` · last commit ${fmtDate(w.updated)}` : ''}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="actions">
            <button className="ghost" onClick={() => void load()}>Rescan the workspace</button>
          </div>
          {error && <p className="conn-err">{error}</p>}
        </div>
      )}
    </div>
  );
}

const OUTCOME_LABEL: Record<FixStep['outcome'], string> = {
  kept: 'kept — tests passed',
  retried: 'tests failed, tried again',
  'no-changes': 'no usable change produced',
  'model-failed': 'the model call failed',
};

/** Every attempt at the patch, including the ones that did not work.
 *
 *  "Fixed in 3 attempts" is a number you either trust or you don't. What the
 *  first two tried, which edits the file refused, and what the suite actually
 *  said is the difference between a patch somebody can review and one they have
 *  to take on faith. All of this was being written to the run log and thrown
 *  away when the run ended.
 *
 *  Shown expanded when the fix failed and collapsed when it worked: a working
 *  patch is read by looking at the diff, a failed one is read by looking at why.
 */
function WorkLog({ trail }: { trail: FixStep[] }) {
  const worked = trail.some((step) => step.outcome === 'kept');
  const [open, setOpen] = useState(!worked);

  return (
    <div className="worklog">
      <button className="worklog-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="worklog-title">Work log</span>
        <span className="conn-meta">
          {trail.length} attempt{trail.length === 1 ? '' : 's'}
          {worked ? '' : ' · none landed'}
        </span>
        <span className="conn-meta">{open ? '−' : '+'}</span>
      </button>

      {open && (
        <ol className="worklog-list">
          {trail.map((step) => (
            <li key={`${step.n}-${step.at}`} className="worklog-step" data-outcome={step.outcome}>
              <div className="worklog-step-head">
                <span className="worklog-n">attempt {step.n}</span>
                <span className={`tag ${step.outcome === 'kept' ? 'good' : step.outcome === 'retried' ? 'warning' : 'plain'}`}>
                  {OUTCOME_LABEL[step.outcome]}
                </span>
                <span className="conn-meta">{fmtDate(step.at)}</span>
              </div>

              {step.edits.length > 0 && (
                <ul className="evidence">
                  {step.edits.map((e) => (
                    <li key={e.path}><code>{e.path}</code>{e.why && <div className="q">{e.why}</div>}</li>
                  ))}
                </ul>
              )}

              {/* An edit refused because its anchor text did not match exactly
                  once. Worth showing: it is the most common reason an attempt
                  produces nothing, and it is the model's mistake rather than
                  the code's. */}
              {step.rejected.length > 0 && (
                <p className="conn-err">{step.rejected.length} edit(s) refused — {step.rejected[0]}</p>
              )}
              {step.modelError && <p className="conn-err">{step.modelError}</p>}
              {step.testOutput && !step.testsPassed && (
                <pre className="payload">{step.testOutput}</pre>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

const STEP_ORDER = ['forking', 'cloning', 'reading', 'patching', 'pushing', 'publishing'] as const;

const STEP_LABEL: Record<(typeof STEP_ORDER)[number], string> = {
  forking: 'Fork it, so nothing touches the real project',
  cloning: 'Check out the code',
  reading: 'Read the source against the complaint',
  patching: 'Write a patch and run the tests',
  pushing: 'Push the patch and open a pull request',
  publishing: 'Publish the record to the fork',
};
