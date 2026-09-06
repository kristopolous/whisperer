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
/** What it takes to post a reply on a venue, as opposed to read it.
 *
 *  Reading and writing are different credentials on every one of these, and the
 *  difference is invisible until somebody expects a reply to go out. X is the
 *  clearest case: `X_BEARER_TOKEN` is app-only auth, which reads the public
 *  timeline and cannot post — replying needs OAuth on behalf of an account, and
 *  no amount of the bearer token substitutes for it.
 *
 *  `needs` is empty where replying is not a matter of credentials at all: a
 *  Discord invite is somewhere a person goes, not an API to post through. */
interface ReplyPath { needs: string[]; how: string }

const UGC: {
  key: string; label: string; hint: string;
  platforms: string[]; hosts: RegExp; reply: ReplyPath;
}[] = [
  { key: 'reddit', label: 'Reddit', hint: 'the product\u2019s subreddit, or wherever its users gather', platforms: ['reddit'], hosts: /(^|\.)reddit\.com$/i , reply: { needs: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USERNAME', 'REDDIT_PASSWORD'], how: 'as the account those credentials belong to' } },
  { key: 'x', label: 'X', hint: 'the official account, and any community or parody one', platforms: ['x', 'twitter'], hosts: /(^|\.)(x|twitter)\.com$/i , reply: { needs: ['X_WRITE_TOKEN'], how: 'needs OAuth on behalf of an account — the bearer token is read-only and cannot post' } },
  { key: 'youtube', label: 'YouTube', hint: 'the channel \u2014 reviews and tutorials carry their comment sections', platforms: ['youtube'], hosts: /(^|\.)(youtube\.com|youtu\.be)$/i , reply: { needs: ['YOUTUBE_API_KEY'], how: 'comment replies, via the Data API with an OAuth client' } },
  { key: 'hackernews', label: 'Hacker News', hint: 'the Show HN or launch thread', platforms: ['hackernews', 'hacker news'], hosts: /(^|\.)ycombinator\.com$/i , reply: { needs: ['HN_USERNAME', 'HN_PASSWORD'], how: 'by signing in; HN has no write API' } },
  { key: 'discord', label: 'Discord', hint: 'the community server invite', platforms: ['discord'], hosts: /(^|\.)(discord\.gg|discord\.com)$/i , reply: { needs: ['DISCORD_TOKEN'], how: 'as a bot, and only in servers it has been invited to' } },
  { key: 'github', label: 'GitHub', hint: 'the org or repository, where issues are filed', platforms: ['github'], hosts: /(^|\.)github\.(com|io)$/i , reply: { needs: ['GITHUB_TOKEN'], how: 'issue comments — and only ever on a fork, never upstream' } },
  { key: 'forum', label: 'Own forum', hint: 'a support or community forum on their own domain', platforms: ['forum', 'discourse'], hosts: /(^|\.)(discourse\.\w+|forum\.\w+)/i , reply: { needs: [], how: 'no API — someone has to post it' } },
  { key: 'stackoverflow', label: 'Stack Overflow', hint: 'the tag people ask questions under', platforms: ['stackoverflow'], hosts: /(^|\.)(stackoverflow\.com|stackexchange\.com)$/i , reply: { needs: [], how: 'no write API worth the name — someone has to post it' } },
  { key: 'linkedin', label: 'LinkedIn', hint: 'the company page', platforms: ['linkedin'], hosts: /(^|\.)linkedin\.com$/i , reply: { needs: [], how: 'no usable write API' } },
  { key: 'tiktok', label: 'TikTok', hint: 'short-form reviews, heavily commented', platforms: ['tiktok'], hosts: /(^|\.)tiktok\.com$/i , reply: { needs: ['TIKNEURON_MCP_API_KEY'], how: 'through the TikNeuron connector' } },
  { key: 'instagram', label: 'Instagram', hint: 'the account and its comments', platforms: ['instagram'], hosts: /(^|\.)instagram\.com$/i , reply: { needs: ['INSTAGRAM_ACCESS_TOKEN'], how: 'comment replies on your own posts only' } },
  { key: 'telegram', label: 'Telegram', hint: 'a group or channel invite', platforms: ['telegram'], hosts: /(^|\.)(t\.me|telegram\.(me|org))$/i , reply: { needs: ['TELEGRAM_SESSION_STRING'], how: 'as the account that session belongs to' } },
];

/** Which UGC venue a channel belongs to, or null for anything else.
 *
 *  Two tests, and both are needed. The platform string is compared exactly,
 *  because several of these names are short enough to appear inside unrelated
 *  words — a loose test for X matches almost everything, and anchoring the same
 *  pattern against a platform-and-URL string instead matches nothing at all,
 *  which is what put every X account under "Elsewhere" while X sat in the gap
 *  list saying nobody had found one.
 *
 *  The host is the fallback, because the platform string is whatever the source
 *  that produced it decided to call the venue: a Discord link arrives as
 *  `discord.gg` from a crawl and `discord` from a pasted URL. */
function venueFor(profile: Profile): string | null {
  const platform = profile.platform.trim().toLowerCase();
  let host = '';
  try {
    host = new URL(profile.url.startsWith('http') ? profile.url : `https://${profile.url}`)
      .host.toLowerCase().replace(/^www\./, '');
  } catch {
    host = '';
  }
  return UGC.find((venue) =>
    venue.platforms.includes(platform) || (host !== '' && venue.hosts.test(host)))?.key ?? null;
}

interface Overrides { blocked: string[]; added: Profile[] }
interface SourcesState { profiles: Profile[]; overrides: Overrides }

/** Where to look for what people are saying, and what is missing from that list.
 *
 *  Called Sources rather than Presence because the page stopped being a report
 *  and became a control. "Presence" describes an output — here is the footprint
 *  we found — and everything on this page now is an input: the venues with
 *  nothing on them, the channel somebody added by hand, the one they refused.
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
export function SourcesView({ scan }: { scan: Scan }) {
  const [query, setQuery] = useState('');
  const [state, setState] = useState<SourcesState>({
    profiles: scan.profiles,
    overrides: { blocked: [], added: [] },
  });
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Which credentials exist, so each venue can say whether a reply could
  // actually be sent from it. Reading a venue and writing to it are different
  // keys everywhere, and the gap between them is invisible until somebody
  // expects an answer to reach the person who complained.
  const [held, setHeld] = useState<Set<string>>(new Set());

  useEffect(() => {
    let live = true;
    api<SourcesState>(`api/scans/${scan.id}/presence`)
      .then((data) => { if (live) setState(data); })
      .catch(() => {});
    api<{ name: string; source: string }[]>('api/credentials')
      .then((rows) => {
        if (live) setHeld(new Set(rows.filter((r) => r.source !== 'missing').map((r) => r.name)));
      })
      .catch(() => {});
    return () => { live = false; };
  }, [scan.id, scan.profiles.length]);

  const act = useCallback(async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      setState(await api<SourcesState>(`api/scans/${scan.id}/presence`, {
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
          <h3>No sources found yet</h3>
          <p>
            The sweep over <b>{scan.site || 'the web'}</b> turned up nowhere to look. That is a
            finding in itself for a company people usually talk about — and if you know where
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
          reply={venue.reply}
          held={held}
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
function Section({ title, profiles, onBlock, busy, showPlatform = false, reply, held }: {
  title: string;
  profiles: Profile[];
  onBlock: (url: string) => void;
  busy: boolean;
  showPlatform?: boolean;
  reply?: ReplyPath;
  held?: Set<string>;
}) {
  if (profiles.length === 0) return null;

  // Whether a reply could be sent here. Said on the venue rather than the row,
  // because it is a fact about the venue's API and not about one account.
  const missing = reply && held ? reply.needs.filter((name) => !held.has(name)) : [];
  const canReply = Boolean(reply && reply.needs.length > 0 && missing.length === 0);

  return (
    <>
      <div className="presence-section">
        {title}
        {reply && (
          <span className={`tag ${canReply ? 'good' : 'plain'}`}>
            {canReply
              ? 'can reply'
              : reply.needs.length === 0
                ? 'read only'
                : `read only — needs ${missing.join(', ')}`}
          </span>
        )}
        {reply && !canReply && <span className="q"> {reply.how}</span>}
      </div>
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
