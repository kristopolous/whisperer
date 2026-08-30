import type { Profile, Scan } from '../../../shared/types.ts';

const KIND: Record<'official' | 'unofficial', string> = { official: 'official', unofficial: 'unofficial' };

/** The full footprint, split into the channels the company itself runs and the
 *  unofficial ones — communities, reviews, impersonations — that live outside it. */
export function PresenceView({ scan }: { scan: Scan }) {
  const official = scan.profiles.filter((p) => p.official);
  const unofficial = scan.profiles.filter((p) => !p.official);

  if (scan.profiles.length === 0) {
    return (
      <div className="panel">
        <div className="empty">
          <h3>No public footprint found</h3>
          <p>
            The sweep over <b>{scan.site || 'the web'}</b> turned up no channels to report. That is
            a finding in itself for a company people usually talk about.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="panel">
      <Section title={`Official — ${official.length}`} profiles={official} />
      <Section title={`Unofficial — ${unofficial.length}`} profiles={unofficial} />
    </div>
  );
}

function Section({ title, profiles }: { title: string; profiles: Profile[] }) {
  if (profiles.length === 0) return null;
  return (
    <>
      <div className="presence-section">{title}</div>
      <div className="presence-table">
        {profiles.map((p) => (
          <a key={p.url} className="presence-row" href={p.url} target="_blank" rel="noreferrer">
            <div className="t">{p.platform}</div>
            <div className="handle">@{p.handle.replace(/^@+/, '')}</div>
            <div className="meta">
              <span className={`tag ${p.official ? 'good' : 'plain'}`}>
                {KIND[p.official ? 'official' : 'unofficial']}
              </span>
            </div>
          </a>
        ))}
      </div>
    </>
  );
}
