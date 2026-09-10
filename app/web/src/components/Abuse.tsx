import { useEffect, useState } from 'react';
import type { AbuseFinding, ReviewKind, ReviewScore, Scan } from '../../../shared/types.ts';
import { api, fmtDate, plain } from '../lib.ts';
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
/** The reviews behind the scores, from every site at once, newest first.
 *
 *  Its own card because it answers a different question. The scorecard says
 *  where the company stands; this says which way it is going and why — and the
 *  "why" only exists in what people wrote.
 *
 *  Amalgamated rather than grouped by site, because the trend is the point. A
 *  1-star on Trustpilot in July and a 1-star on Product Hunt in August are the
 *  same story continuing, and reading them in two separate lists is how you
 *  miss that. Sorted by date across all of them, with the site named on each
 *  row so the source is never in doubt.
 */
function RecentReviews({ reviews }: { reviews: ReviewScore[] }) {
  const all = reviews
    .flatMap((score) => (score.recent ?? []).map((r) => ({ ...r, site: score.site, url: score.url })))
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));

  if (all.length === 0) return null;

  // Where the recent ones sit against the published average. A run of 1s under
  // a 4.2 is the thing worth acting on, and it is invisible in either number
  // alone.
  const rated = all.filter((r) => typeof r.rating === 'number');
  const mean = rated.length
    ? rated.reduce((sum, r) => sum + (r.rating ?? 0), 0) / rated.length
    : null;

  return (
    <div className="panel">
      <div className="set-head">
        <strong>What people are writing</strong>
        <span className="tag plain">{all.length} recent</span>
        {mean !== null && (
          <span className={`tag ${mean < 3 ? 'critical' : mean < 4 ? 'warning' : 'good'}`}>
            {mean.toFixed(1)} avg across these
          </span>
        )}
      </div>

      <ul className="revs">
        {all.map((r, i) => (
          <li key={`${r.site}-${i}`}>
            <div className="revs-head">
              {typeof r.rating === 'number' && (
                <span className={`tag ${r.rating <= 2 ? 'critical' : r.rating <= 3 ? 'warning' : 'good'}`}>
                  {r.rating}/5
                </span>
              )}
              <a href={r.url} target="_blank" rel="noreferrer">{r.site}</a>
              <span className="conn-meta">{r.date ? fmtDate(r.date) : 'undated'}</span>
              {r.author && <span className="conn-meta">{r.author}</span>}
            </div>
            {r.title && <div className="revs-title">{r.title}</div>}
            <p className="revs-body">{plain(r.body)}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

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
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div className="panel">
      <div className="set-head">
        <strong>Public scores</strong>
        <span className="tag plain">
          {reviews.filter((r) => r.verified).length} read
          {reviews.some((r) => !r.verified) ? ` · ${reviews.filter((r) => !r.verified).length} blocked` : ''}
        </span>
      </div>

      {/* A score with nothing under it is a number to take on trust, which is
          the one thing this product exists not to ask. Each row carries the
          reviews it was calculated from, and says plainly when it could not get
          them — "we could not read them" and "there are none" are different
          facts and both beat a bare figure. */}
      <div className="scores">
        {ordered.map((r) => {
          const share = r.rating / r.scale;
          const recent = r.recent ?? [];
          const showing = open === r.site + r.url;
          return (
            <div key={r.site + r.url} className="score-line">
              <button
                className="score-head"
                onClick={() => setOpen(showing ? null : r.site + r.url)}
                data-tone={!r.verified ? 'unread' : share >= 0.8 ? 'good' : share >= 0.6 ? 'mid' : 'bad'}
              >
                <span className="score-site">{r.site}</span>
                {/* No number unless the site's own page stated it. What a
                    search result said near the site's name is not that site's
                    score, and printing it as one invents a company's
                    reputation. */}
                <span className="score-value">
                  {r.verified
                    ? <>{r.rating}<span className="score-scale">/{r.scale}</span></>
                    : <span className="score-blocked">not readable</span>}
                </span>
                <span className="conn-meta">
                  {KIND_LABEL[r.kind]}
                  {r.verified && r.count ? ` · ${r.count.toLocaleString()} reviews` : ''}
                </span>
                <span className={`tag ${recent.length ? 'plain' : 'warning'}`}>
                  {recent.length
                    ? `${showing ? 'hide' : 'read'} ${recent.length}`
                    : r.verified ? 'reviews unreadable' : 'page blocked'}
                </span>
              </button>

              {showing && recent.length > 0 && (
                <ul className="revs">
                  {recent.map((review, i) => (
                    <li key={i}>
                      <div className="revs-head">
                        {typeof review.rating === 'number' && (
                          <span className={`tag ${review.rating <= 2 ? 'critical' : review.rating <= 3 ? 'warning' : 'good'}`}>
                            {review.rating}/5
                          </span>
                        )}
                        <span className="conn-meta">{review.date ? fmtDate(review.date) : 'undated'}</span>
                        {review.author && <span className="conn-meta">{review.author}</span>}
                        <a href={r.url} target="_blank" rel="noreferrer" className="conn-meta">open</a>
                      </div>
                      {review.title && <div className="revs-title">{review.title}</div>}
                      <p className="revs-body">{plain(review.body)}</p>
                    </li>
                  ))}
                </ul>
              )}

              {showing && recent.length === 0 && (
                <p className="q score-none">
                  {r.verified
                    ? 'The score is the site\u2019s own published figure, but no individual reviews '
                      + 'could be read out of the page \u2014 these sites serve a sign-in wall to '
                      + 'anything that is not a browser.'
                    : 'This site serves nothing to a request that is not a browser, so its score '
                      + 'could not be read. The figure that appeared in search results is not this '
                      + 'site\u2019s score \u2014 it is a number found near its name \u2014 so it '
                      + 'is not shown. A logged-in scraper would get past this.'}
                  {' '}<a href={r.url} target="_blank" rel="noreferrer">Open it</a>.
                </p>
              )}
            </div>
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
        <RecentReviews reviews={scan.reviews ?? []} />
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
    <RecentReviews reviews={scan.reviews ?? []} />
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
