import { useEffect, useState } from 'react';
import type { Issue, Scan, Tracker } from '../../../shared/types.ts';
import { api, fmtDate, venueOf } from '../lib.ts';
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
  const issues = [...scan.issues].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
  const [selected, setSelected] = useState(issues[0]?.id);
  const issue = issues.find((i) => i.id === selected) ?? issues[0];

  useEffect(() => { if (issues.length && !issues.some((i) => i.id === selected)) setSelected(issues[0].id); },
    [scan.id, issues.length]);

  if (issues.length === 0) {
    return (
      <div className="panel">
        <div className="empty">
          <h3>Nothing to fix</h3>
          <p>
            No complaint in the discussion pointed at a real defect. That is a finding, not an
            empty result — the criticism that did come up was opinion or preference, and it stays
            in the ledger above.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="docket">
        <div className="docket-list" role="listbox" aria-label="Issue catalogue">
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

function Report({ scan, issue, onChange }: { scan: Scan; issue: Issue; onChange: (issue: Issue) => void }) {
  const [payload, setPayload] = useState<{ tracker: Tracker; title: string; body: string; labels: string[]; endpoint: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setPayload(null), [issue.id]);

  const evidence = issue.evidence
    .map((id) => scan.mentions.find((m) => m.id === id))
    .filter((m): m is NonNullable<typeof m> => Boolean(m));

  const preview = async (tracker: Tracker) => {
    setBusy(true);
    try {
      setPayload(await api(`/api/scans/${scan.id}/issues/${issue.id}/payload`, {
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
      onChange(await api(`/api/scans/${scan.id}/issues/${issue.id}/file`, {
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
