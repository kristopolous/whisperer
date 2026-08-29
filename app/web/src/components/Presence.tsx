import type { Profile, Scan } from '../../../shared/types.ts';

/** Compact chips, shown under the site in the subject line. */
export function Presence({ profiles }: { profiles: Profile[] }) {
  if (profiles.length === 0) return null;
  return (
    <div className="presence">
      {profiles.map((p) => (
        <a className="chip" key={p.url} href={p.url} target="_blank" rel="noreferrer">
          {p.platform} <b>{p.handle}</b>
        </a>
      ))}
    </div>
  );
}

const CONFIDENCE: Record<Profile['confidence'], string> = { high: 'confirmed', low: 'inferred' };

/** The Presence tab: every account found on the site, as a docket-style list.
 *  If none were found that is a finding in itself — an offline footprint. */
export function PresenceView({ scan }: { scan: Scan }) {
  if (scan.profiles.length === 0) {
    return (
      <div className="panel">
        <div className="empty">
          <h3>Quiet corner of the web</h3>
          <p>
            Reading <b>{scan.site || 'the site'}</b> turned up no social or community accounts to
            add to the sweep. That narrows where the conversation could be happening.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="presence-table">
        {scan.profiles.map((p) => (
          <a key={p.url} className="presence-row" href={p.url} target="_blank" rel="noreferrer">
            <div className="t">{p.platform}</div>
            <div className="handle">@{p.handle}</div>
            <div className="meta">
              <span className="tag plain">{CONFIDENCE[p.confidence]}</span>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
