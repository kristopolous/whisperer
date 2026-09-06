import { useEffect, useState } from 'react';
import type { AbuseFinding, ReviewKind, ReviewScore, Scan } from '../../../shared/types.ts';
import { api, fmtDate } from '../lib.ts';
import { Filter, matches } from './Filter.tsx';

const STATUS_ORDER: AbuseFinding['status'][] = ['open', 'reported', 'dismissed'];

/** Integrity is a docket like Health: the findings down one rail, the report in
 *  the pane. A finding is selected at all times so there is no blank frame. */
const KIND_LABEL: Record<ReviewKind, string> = {
  software: 'Software buyers',
  customer: 'Customers',
  app: 'App users',
  employer: 'Staff',
};

const KIND_ORDER: ReviewKind[] = ['software', 'customer', 'app', 'employer'];

/** The public scorecard: what this company scores on the sites people check.
 *
 *  Leads the tab because it is what anyone actually looks up, and because it is
 *  almost always populated — whereas brand abuse is rare, so a tab that led
 *  with it said "name is clean" and nothing else, forever.
 *
 *  Scores are grouped rather than averaged. A company can be loved by software
 *  buyers and hated by its own staff, and one number across the two describes
 *  nobody. */
function Scorecard({ reviews }: { reviews: ReviewScore[] }) {
  if (reviews.length === 0) return null;

  // One grid, ordered by audience rather than split into a section per
  // audience.
  //
  // A section each meant the layout depended on how the scores happened to
  // divide: Lovable has three, one per audience, so every "row" held a single
  // card and the three-column grid did nothing. The audience still matters —
  // a company can be loved by software buyers and hated by its own staff —
  // but it belongs on the card, not in the page structure.
  const ordered = KIND_ORDER.flatMap((kind) => reviews.filter((r) => r.kind === kind));

  return (
    <div className="panel">
      <div className="set-head">
        <strong>Public scores</strong>
        <span className="tag plain">{reviews.length} sites</span>
      </div>
      <p className="set-desc">
        What this company scores where buyers, customers and staff go to look. Read from search
        results rather than scraped — these sites block that — so each one links back and carries
        the sentence it came from.
      </p>

      <div className="score-row">
        {ordered.map((r) => {
          const share = r.rating / r.scale;
          return (
            <a
              key={r.site + r.url}
              className="score"
              href={r.url}
              target="_blank"
              rel="noreferrer"
              title={r.quote}
              data-tone={share >= 0.8 ? 'good' : share >= 0.6 ? 'mid' : 'bad'}
            >
              <span className="score-kind">{KIND_LABEL[r.kind]}</span>
              <span className="score-site">{r.site}</span>
              <span className="score-value">
                {r.rating}<span className="score-scale">/{r.scale}</span>
              </span>
              <span className="score-meta">
                {r.count ? `${r.count.toLocaleString()} reviews` : 'count not stated'}
                {!r.firstParty && ' · quoted'}
              </span>
            </a>
          );
        })}
      </div>
    </div>
  );
}

export function Abuse({ scan, onStatus }: { scan: Scan; onStatus: (finding: AbuseFinding) => void }) {
  const [query, setQuery] = useState('');
  const allFindings = [...scan.abuse].sort(
    (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status),
  );
  const findings = allFindings.filter((f) => matches(query, f.title, f.summary, f.kind, f.severity));
  const [selected, setSelected] = useState(findings[0]?.id);
  const finding = findings.find((f) => f.id === selected) ?? findings[0];

  useEffect(() => {
    if (findings.length && !findings.some((f) => f.id === selected)) setSelected(findings[0].id);
  }, [scan.id, findings.length]);

  // See the note in Health: this must test the unfiltered list, or a query
  // that matches nothing takes the filter away with the rows.
  if (allFindings.length === 0) {
    return (
      <>
        <Scorecard reviews={scan.reviews ?? []} />
        <div className="panel">
          <div className="empty">
            <h3>Nothing abusing the brand</h3>
            <p>
              No impersonating accounts, lookalike domains, scams or fake support turned up in the
              search. That is the result — nothing needs reporting.
            </p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
    <Scorecard reviews={scan.reviews ?? []} />
    <div className="panel">
      <div className="docket">
        <div className="docket-list" role="listbox" aria-label="Integrity findings">
          <Filter
            value={query}
            onChange={setQuery}
            placeholder="Search findings…"
            showing={findings.length}
            total={allFindings.length}
          />
          {findings.length === 0 && <div className="dash-empty">Nothing matches “{query}”.</div>}
          {findings.map((f) => (
            <button
              key={f.id}
              className="docket-row"
              aria-current={f.id === finding.id}
              onClick={() => setSelected(f.id)}
            >
              <div className="t">{f.title}</div>
              <div className="m">
                <span className={`tag ${f.severity}`}>{f.severity}</span>
                <span className="tag plain">{f.kind}</span>
                <span style={{ font: '400 10.5px var(--mono)', color: 'var(--ink-3)' }}>
                  {f.locations.length} {f.locations.length === 1 ? 'location' : 'locations'}
                </span>
              </div>
            </button>
          ))}
        </div>
        <Finding scanId={scan.id} finding={finding} onStatus={onStatus} />
      </div>
    </div>
    </>
  );
}

function Finding({
  scanId, finding, onStatus,
}: { scanId: string; finding: AbuseFinding; onStatus: (f: AbuseFinding) => void }) {
  const [busy, setBusy] = useState(false);

  const setStatus = async (status: AbuseFinding['status']) => {
    setBusy(true);
    try {
      onStatus(await api(`api/scans/${scanId}/abuse/${finding.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      }));
    } finally { setBusy(false); }
  };

  return (
    <div className="report">
      <h4>{finding.title}</h4>
      <div className="meta">
        <span className={`tag ${finding.severity}`}>{finding.severity}</span>
        <span className="tag plain">{finding.kind}</span>
        <span style={{ font: '400 11px var(--mono)', color: 'var(--ink-3)' }}>
          {finding.firstSeen ? `first seen ${fmtDate(finding.firstSeen)}` : 'undated'}
        </span>
        <span className={`tag ${finding.status === 'reported' ? 'good' : finding.status === 'dismissed' ? 'warning' : 'critical'}`}>
          {finding.status}
        </span>
      </div>

      <h5>What it is</h5>
      <p>{finding.summary}</p>

      <h5>Who it hurts</h5>
      <p>{finding.harm}</p>

      <h5>Where it lives</h5>
      <ul className="evidence">
        {finding.locations.map((loc) => (
          <li key={loc}>
            <span className="q">{loc}</span>
          </li>
        ))}
        {finding.locations.length === 0 && <li className="q">No locations recorded.</li>}
      </ul>

      <h5>What to do</h5>
      <p className="reply">{finding.recommendation}</p>

      <h5>Status</h5>
      <div className="actions">
        {(['open', 'reported', 'dismissed'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            disabled={busy || s === finding.status}
            style={s === finding.status ? { borderColor: 'var(--signal)', color: 'var(--signal)' } : undefined}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
