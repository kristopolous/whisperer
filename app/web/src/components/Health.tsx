import { useEffect, useState } from 'react';
import type { Issue, Scan, Tracker } from '../../../shared/types.ts';
import { api, fmtDate, venueOf } from '../lib.ts';
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
export function Health({ scan, onChange }: { scan: Scan; onChange: (issue: Issue) => void }) {
  const [query, setQuery] = useState('');
  const all = [...scan.issues].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
  const issues = all.filter((i) => matches(query, i.title, i.summary, i.impact, i.kind, i.severity));
  const [selected, setSelected] = useState(issues[0]?.id);
  const issue = issues.find((i) => i.id === selected) ?? issues[0];

  useEffect(() => { if (issues.length && !issues.some((i) => i.id === selected)) setSelected(issues[0].id); },
    [scan.id, issues.length]);

  if (issues.length === 0) {
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
            Triage read the highest-ranked complaints and none pointed at a reproducible defect — what
            came up was opinion or preference rather than something that can be fixed.
          </p>
          {complaints > 0 && (
            <p>
              {complaints} mention{complaints === 1 ? '' : 's'} did read as a complaint, so that is
              worth a second look rather than taking at face value. They are listed under Discovery,
              complaints first.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="docket">
        <div className="docket-list" role="listbox" aria-label="Issue catalogue">
          <Filter
            value={query}
            onChange={setQuery}
            placeholder="Search issues…"
            showing={issues.length}
            total={all.length}
          />
          {issues.map((i) => (
            <button
              key={i.id}
              className="docket-row"
              aria-current={i.id === issue.id}
              onClick={() => setSelected(i.id)}
            >
              <div className="t">{i.title}</div>
              <div className="m">
                <span className={`tag ${i.severity}`}>{i.severity}</span>
                <span className="tag plain">{i.kind}</span>
                <span style={{ font: '400 10.5px var(--mono)', color: 'var(--ink-3)' }}>
                  {i.evidence.length} {i.evidence.length === 1 ? 'report' : 'reports'}
                </span>
                {i.loop?.some((e) => e.step === 'closed') && <span className="tag good">closed by reporter</span>}
                {i.loop?.length && !i.loop.some((e) => e.step === 'closed')
                  ? <span className="tag warning">awaiting reporter</span>
                  : null}
              </div>
            </button>
          ))}
        </div>
        <Report scan={scan} issue={issue} onChange={onChange} />
      </div>
    </div>
  );
}

interface Payload { tracker: Tracker; title: string; body: string; labels: string[]; endpoint: string }

function Report({ scan, issue, onChange }: { scan: Scan; issue: Issue; onChange: (issue: Issue) => void }) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [busy, setBusy] = useState(false);

  // Reading the source and patching it are minutes of model time, so the state
  // here is per-issue and the buttons say which phase they are in rather than
  // just spinning.
  const [working, setWorking] = useState<'diagnose' | 'fix' | null>(null);
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
  const hasRepo = Boolean(scan.subject?.repo)
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

  const evidence = issue.evidence
    .map((id) => scan.mentions.find((m) => m.id === id))
    .filter((m): m is NonNullable<typeof m> => Boolean(m));

  const preview = async (tracker: Tracker) => {
    setBusy(true);
    try {
      setPayload(await api<Payload>(`api/scans/${scan.id}/issues/${issue.id}/payload`, {
        method: 'POST', body: JSON.stringify({ tracker }),
      }));
    } finally { setBusy(false); }
  };

  const file = async () => {
    if (!payload) return;
    setBusy(true);
    try {
      if (payload.tracker === 'clipboard') {
        await navigator.clipboard.writeText(`${payload.title}\n\n${payload.body}`);
      }
      onChange(await api(`api/scans/${scan.id}/issues/${issue.id}/file`, {
        method: 'POST', body: JSON.stringify({ tracker: payload.tracker }),
      }));
    } finally { setBusy(false); }
  };

  return (
    <div className="report">
      <h4>{issue.title}</h4>
      <div className="meta">
        <span className={`tag ${issue.severity}`}>{issue.severity}</span>
        <span className="tag plain">{issue.kind}</span>
        <span style={{ font: '400 11px var(--mono)', color: 'var(--ink-3)' }}>
          {issue.firstSeen ? `first reported ${fmtDate(issue.firstSeen)}` : 'undated'}
          {issue.lastSeen && issue.lastSeen !== issue.firstSeen ? ` · last ${fmtDate(issue.lastSeen)}` : ''}
        </span>
        {issue.filedTo && (
          <span className="tag good">filed to {issue.filedTo.tracker}</span>
        )}
      </div>

      <p>{issue.summary}</p>

      <h5>Impact</h5>
      <p>{issue.impact}</p>

      <h5>Reported in</h5>
      <ul className="evidence">
        {evidence.map((m) => (
          <li key={m.id}>
            <a href={m.url} target="_blank" rel="noreferrer">{m.title}</a>
            <div className="q">
              {venueOf(m.venue).label} · {fmtDate(m.date)} — “{m.excerpt.slice(0, 200)}{m.excerpt.length > 200 ? '…' : ''}”
            </div>
          </li>
        ))}
        {evidence.length === 0 && <li className="q">The supporting threads are no longer in this scan.</li>}
      </ul>

      <ResolutionLoop issue={issue} />

      <h5>Go into the source</h5>
      {!hasRepo ? (
        <p className="q">
          No repository is configured for <b>{scan.company}</b>. Add it to <code>config/repos.json</code>
          {' '}to diagnose this against real code.
        </p>
      ) : (
        <>
          <div className="actions">
            <button className="primary" onClick={tryToFix} disabled={working !== null}>
              {working === 'diagnose' ? 'Reading the source…'
                : working === 'fix' ? 'Patching and running tests…'
                  : issue.fix ? 'Try again' : 'Try to fix it'}
            </button>
            <button onClick={() => runSource('diagnose')} disabled={working !== null}>
              {issue.diagnosis ? 'Diagnose again' : 'Diagnose only'}
            </button>
          </div>
          <p className="q">
            Reads the project's source, then writes a patch and runs the test suite in a throwaway
            copy. Nothing is committed or pushed, and a fix is only reported as working if the new
            regression test fails against the original code.
          </p>
          {sourceError && <p className="conn-err">{sourceError}</p>}
        </>
      )}

      {issue.diagnosis && <DiagnosisView diagnosis={issue.diagnosis} />}
      {issue.fix && <FixView fix={issue.fix} />}

      <h5>Reply to the people who raised it</h5>
      <p className="reply">{issue.draftReply}</p>

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
              {payload.tracker === 'clipboard' ? 'Copy and mark filed' : `Send to ${payload.tracker}`}
            </button>
            <button onClick={() => setPayload(null)}>Discard</button>
          </div>
          {payload.tracker !== 'clipboard' && (
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
