import { useCallback, useEffect, useState } from 'react';
import type { Profile, Scan } from '../../../shared/types.ts';
import { api } from '../lib.ts';
import { Filter, matches } from './Filter.tsx';

const KIND: Record<'official' | 'unofficial', string> = { official: 'official', unofficial: 'unofficial' };

/** The places user-generated complaints actually live.
 *
 *  A fixed list, and that is the whole point of it. Rendering only what the
 *  crawl found answers "what did we find", which is the question nobody needs
 *  answered — the interesting reading is the other one: four X accounts and
 *  nothing at all from YouTube probably means nobody looked at YouTube, not
 *  that YouTube is quiet. A gap is only visible against a list of what ought to
 *  be there, so the empty rows are the feature and they are shown first.
 *
 *  `hint` is what to do about it, because a gap with no next step is just a
 *  reproach. */
const UGC: { key: string; label: string; hint: string; match: RegExp }[] = [
  { key: 'reddit', label: 'Reddit', hint: 'the product\u2019s subreddit, or r/ where its users gather', match: /reddit/i },
  { key: 'x', label: 'X', hint: 'the official account, and any community or parody one', match: /^(x|twitter)$/i },
  { key: 'youtube', label: 'YouTube', hint: 'the channel \u2014 reviews and tutorials carry their comment sections', match: /youtube|youtu\.be/i },
  { key: 'hackernews', label: 'Hacker News', hint: 'the Show HN or launch thread', match: /hacker\s*news|ycombinator/i },
  { key: 'discord', label: 'Discord', hint: 'the community server invite', match: /discord/i },
  { key: 'github', label: 'GitHub', hint: 'the org or repository, where issues are filed', match: /github/i },
  { key: 'forum', label: 'Own forum', hint: 'a support or community forum on their own domain', match: /forum|discourse|community|support/i },
  { key: 'stackoverflow', label: 'Stack Overflow', hint: 'the tag people ask questions under', match: /stack\s*overflow|stackexchange/i },
  { key: 'linkedin', label: 'LinkedIn', hint: 'the company page', match: /linkedin/i },
  { key: 'tiktok', label: 'TikTok', hint: 'short-form reviews, heavily commented', match: /tiktok/i },
  { key: 'instagram', label: 'Instagram', hint: 'the account and its comments', match: /instagram/i },
  { key: 'telegram', label: 'Telegram', hint: 'a group or channel invite', match: /telegram|t\.me/i },
];

/** Which UGC venue a found channel belongs to, or null for anything else.
 *  Matched on the platform the crawl assigned and on the URL, because the two
 *  disagree often enough to matter — a Discord invite arrives as `discord.gg`
 *  from one source and `discord` from another. */
function venueFor(profile: Profile): string | null {
  const subject = `${profile.platform} ${profile.url}`;
  return UGC.find((venue) => venue.match.test(subject))?.key ?? null;
}

interface Overrides { blocked: string[]; added: Profile[] }
interface PresenceState { profiles: Profile[]; overrides: Overrides }

/** The full footprint, and the controls to correct it.
 *
 *  Editable because this is an input, not a readout. A subreddit here becomes a
 *  direct query against that subreddit on the next run and a GitHub org becomes
 *  an issue search, so a wrong entry sends every later stage somewhere useless
 *  and a missing one costs the best source there is. Neither is something the
 *  crawl can be relied on to get right — the company does not link its own
 *  community half the time, and a name-shaped search result is not the same
 *  thing as an account.
 *
 *  Removing is a rule, not an edit. Deleting a row from one run would achieve
 *  nothing: the next crawl does the same sweep and finds it again. So a removal
 *  is remembered against the company and reapplied every time.
 */
export function PresenceView({ scan }: { scan: Scan }) {
  const [query, setQuery] = useState('');
  const [state, setState] = useState<PresenceState>({
    profiles: scan.profiles,
    overrides: { blocked: [], added: [] },
  });
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api<PresenceState>(`api/scans/${scan.id}/presence`)
      .then((data) => { if (live) setState(data); })
      .catch(() => {});
    return () => { live = false; };
  }, [scan.id, scan.profiles.length]);

  const act = useCallback(async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      setState(await api<PresenceState>(`api/scans/${scan.id}/presence`, {
        method: 'POST', body: JSON.stringify(body),
      }));
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, '').slice(0, 200));
    } finally {
      setBusy(false);
    }
  }, [scan.id]);

  const shown = state.profiles.filter((p) => matches(query, p.handle, p.url, p.platform));

  const grouped = new Map<string, Profile[]>();
  const elsewhere: Profile[] = [];
  for (const profile of shown) {
    const venue = venueFor(profile);
    if (venue) grouped.set(venue, [...(grouped.get(venue) ?? []), profile]);
    else elsewhere.push(profile);
  }
  // Gaps are computed against everything found, not against the filtered view —
  // a search box should not be able to invent a gap.
  const covered = new Set(state.profiles.map(venueFor).filter((v): v is string => Boolean(v)));
  const gaps = UGC.filter((venue) => !covered.has(venue.key));

  const adder = (
    <div className="presence-add">
      <input
        value={url}
        placeholder="https://reddit.com/r/… or a Discord invite"
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && url.trim()) { void act({ url: url.trim() }); setUrl(''); }
        }}
      />
      <button
        className="ghost"
        disabled={busy || !url.trim()}
        onClick={() => { void act({ url: url.trim() }); setUrl(''); }}
      >
        Add channel
      </button>
      <span className="conn-meta">
        Where to look, not what was found — anything added here is searched on every run.
      </span>
      {error && <div className="conn-err">{error}</div>}
    </div>
  );

  if (state.profiles.length === 0) {
    return (
      <div className="panel">
        <div className="empty">
          <h3>No public footprint found</h3>
          <p>
            The sweep over <b>{scan.site || 'the web'}</b> turned up no channels to report. That is
            a finding in itself for a company people usually talk about — and if you know where
            their community actually is, paste it in.
          </p>
        </div>
        {adder}
        <Blocked overrides={state.overrides} onUnblock={(u) => act({ url: u, action: 'unblock' })} busy={busy} />
      </div>
    );
  }

  return (
    <div className="panel">
      <Filter
        value={query}
        onChange={setQuery}
        placeholder="Search accounts…"
        showing={shown.length}
        total={state.profiles.length}
      />
      {adder}

      <Gaps gaps={gaps} onAdd={(u) => act({ url: u })} busy={busy} />

      {UGC.filter((venue) => grouped.has(venue.key)).map((venue) => (
        <Section
          key={venue.key}
          title={`${venue.label} — ${grouped.get(venue.key)!.length}`}
          profiles={grouped.get(venue.key)!}
          onBlock={(u) => act({ url: u, action: 'block' })}
          busy={busy}
        />
      ))}
      <Section
        title={`Elsewhere — ${elsewhere.length}`}
        profiles={elsewhere}
        onBlock={(u) => act({ url: u, action: 'block' })}
        busy={busy}
        showPlatform
      />
      <Blocked overrides={state.overrides} onUnblock={(u) => act({ url: u, action: 'unblock' })} busy={busy} />
    </div>
  );
}

/** The venues nothing was found on.
 *
 *  First on the panel, above everything that was found, because this is the
 *  part that is worth a person's attention: a venue with four accounts needs
 *  nothing from anybody, and a venue with none is either genuinely empty or —
 *  far more often — a place the crawl could not reach because the company does
 *  not link it. Each row takes a URL, which is the action the gap implies. */
function Gaps({ gaps, onAdd, busy }: {
  gaps: { key: string; label: string; hint: string }[];
  onAdd: (url: string) => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  if (gaps.length === 0) return null;

  return (
    <>
      <div className="presence-section">
        Nothing found on {gaps.length} {gaps.length === 1 ? 'venue' : 'venues'} — the gaps worth checking
      </div>
      <div className="presence-table">
        {gaps.map((venue) => (
          <div key={venue.key} className="presence-row gap">
            <span className="t">{venue.label}</span>
            <div className="handle q">{venue.hint}</div>
            <div className="meta">
              {open === venue.key ? (
                <>
                  <input
                    autoFocus
                    value={url}
                    placeholder="paste the URL"
                    onChange={(e) => setUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && url.trim()) { onAdd(url.trim()); setUrl(''); setOpen(null); }
                      if (e.key === 'Escape') { setUrl(''); setOpen(null); }
                    }}
                  />
                  <button className="ghost" disabled={busy || !url.trim()} onClick={() => { onAdd(url.trim()); setUrl(''); setOpen(null); }}>
                    Add
                  </button>
                </>
              ) : (
                <button className="ghost" onClick={() => { setOpen(venue.key); setUrl(''); }}>
                  I know where this is
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/** One venue's channels.
 *
 *  `showPlatform` is only true for the leftovers. Inside a venue the section
 *  heading already says Reddit, so printing "reddit" again on all four rows is
 *  a column of the same word — the handle is the part that differs, so the
 *  handle is what links. "Elsewhere" is the exception: those rows genuinely are
 *  different platforms and the name is the information. */
function Section({ title, profiles, onBlock, busy, showPlatform = false }: {
  title: string;
  profiles: Profile[];
  onBlock: (url: string) => void;
  busy: boolean;
  showPlatform?: boolean;
}) {
  if (profiles.length === 0) return null;
  return (
    <>
      <div className="presence-section">{title}</div>
      <div className="presence-table">
        {profiles.map((p) => (
          <div key={p.url} className={`presence-row${showPlatform ? '' : ' bare'}`}>
            {showPlatform && <span className="t">{p.platform}</span>}
            <a className="handle" href={p.url} target="_blank" rel="noreferrer">
              @{p.handle.replace(/^@+/, '')}
            </a>
            <div className="meta">
              <span className={`tag ${p.official ? 'good' : 'plain'}`}>
                {KIND[p.official ? 'official' : 'unofficial']}
              </span>
              {/* Not a delete. It is remembered, because the next crawl would
                  find this again otherwise. */}
              <button
                className="ghost"
                disabled={busy}
                title="Wrong channel — remove it and never accept it again"
                onClick={() => onBlock(p.url)}
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/** What has been refused, and a way to change your mind.
 *
 *  Shown rather than hidden: a blocklist nobody can read is a source of
 *  "why does it never find their subreddit" with no way to answer it. */
function Blocked({ overrides, onUnblock, busy }: {
  overrides: Overrides;
  onUnblock: (url: string) => void;
  busy: boolean;
}) {
  if (overrides.blocked.length === 0) return null;
  return (
    <>
      <div className="presence-section">Never accept — {overrides.blocked.length}</div>
      <div className="presence-table">
        {overrides.blocked.map((url) => (
          <div key={url} className="presence-row bare">
            <a className="handle" href={url.startsWith('http') ? url : `https://${url}`} target="_blank" rel="noreferrer">{url}</a>
            <div className="meta">
              <button className="ghost" disabled={busy} onClick={() => onUnblock(url)}>allow again</button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
