import { useState } from 'react';
import type { FeedItem, Scan, Venue } from '../../../shared/types.ts';
import { Filter, matches } from './Filter.tsx';
import { VENUES, fmtDate, plain, venueOf } from '../lib.ts';

/** Pull the video id out of a YouTube watch/shorts/embed URL. */
function youtubeId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.replace(/^\//, '').split('/')[0] || null;
    if (u.hostname.endsWith('youtube.com')) {
      if (u.pathname.startsWith('/embed/') || u.pathname.startsWith('/shorts/')) {
        return u.pathname.split('/')[2] || null;
      }
      const v = u.searchParams.get('v');
      if (v) return v;
    }
  } catch {
    /* not a URL we can read */
  }
  return null;
}

/** The live feed — everything that just came in about the company, newest first.
 *  Each row names its source, shows what was actually said or uploaded, links
 *  back to the original, and embeds the video when the item is a YouTube upload. */
export function FeedView({ scan }: { scan: Scan }) {
  const [query, setQuery] = useState('');
  const [venue, setVenue] = useState<Venue | 'all'>('all');
  const all = scan.feed ?? [];

  const items = all
    .filter((i) => venue === 'all' || venueOf(i.venue).key === venue)
    .filter((i) => matches(query, i.headline, i.snippet, i.author, i.url, i.venue));

  // Only a genuinely empty feed gets the empty state. Emptying it with a filter
  // used to unmount the filter along with the rows, so a search that matched
  // nothing took away the box you would have cleared it in — the panel looked
  // broken and the only way out was to change tab.
  if (all.length === 0) {
    // Why it is empty, not just that it is.
    //
    // "Nothing in the feed yet" was said whether the stage had run and found
    // nothing, run and failed, never run at all, or was running at that moment.
    // Those are four different situations with four different responses, and
    // only one of them is "yet" — a scan interrupted during discovery never
    // reached this stage, and reporting that as an empty feed reads as the
    // internet being quiet about the subject.
    const ran = scan.timings?.feed !== undefined;
    const failed = scan.failedStage === 'feed';
    const running = scan.status === 'running' && scan.stage === 'feed';
    const stopped = !ran && scan.status === 'error';

    return (
      <div className="panel">
        <div className="empty">
          <h3>
            {running ? 'Reading the feed…'
              : failed ? 'The feed stage failed'
                : ran ? 'Nothing recent to show'
                  : stopped ? 'The feed stage never ran'
                    : 'Nothing in the feed yet'}
          </h3>
          <p>
            {running
              ? 'Newest first, as they arrive.'
              : failed
                ? scan.error ?? 'No reason was recorded. Rerun it from the Feed tab.'
                : ran
                  ? 'The stage ran and found nothing recent enough to show. That is a statement '
                    + 'about the last few months, not about the subject as a whole — the corpus on '
                    + 'Discovery goes back further.'
                  : stopped
                    ? `The scan stopped at ${scan.failedStage ?? 'an earlier stage'}, before the `
                      + 'feed was collected. Rerun it and the feed fills in.'
                    : 'It has not been collected yet.'}
          </p>
        </div>
      </div>
    );
  }

  // Only the venues actually present. A row reading "YouTube 0" is a filter
  // that does nothing, and this is a control rather than a survey — the gaps
  // belong on Sources, where they are actionable.
  const present = VENUES.filter((v) => all.some((i) => venueOf(i.venue).key === v.key));

  return (
    <div className="panel feed">
      <Filter
        value={query}
        onChange={setQuery}
        placeholder="Search the feed…"
        showing={items.length}
        total={all.length}
      />

      {present.length > 1 && (
        <div className="legend" role="group" aria-label="Filter by source">
          <button
            className="tag plain"
            aria-pressed={venue === 'all'}
            onClick={() => setVenue('all')}
            style={{ borderColor: venue === 'all' ? 'var(--signal)' : undefined, color: venue === 'all' ? 'var(--ink)' : undefined }}
          >
            All {all.length}
          </button>
          {present.map((v) => {
            const n = all.filter((i) => venueOf(i.venue).key === v.key).length;
            return (
              <button
                key={v.key}
                className="tag"
                aria-pressed={venue === v.key}
                onClick={() => setVenue(venue === v.key ? 'all' : v.key)}
                style={{ color: v.slot, borderColor: venue === v.key ? v.slot : undefined }}
              >
                {v.label} {n}
              </button>
            );
          })}
        </div>
      )}

      {items.length === 0
        ? <div className="empty"><h3>Nothing matches</h3></div>
        : items.map((item) => <FeedRow key={item.id} item={item} />)}
    </div>
  );
}

/** One line per item: where it came from, what it says, when.
 *
 *  This was a stacked block per row — a source line, a headline, an author, a
 *  snippet, an "Open in…" link, and for YouTube a 240px video embed. Six items
 *  filled the screen, which is the opposite of what a feed is for. A feed is
 *  read by scanning it, and scanning needs rows.
 *
 *  The whole row is the link, so there is nothing to aim at; the snippet moves
 *  to the tooltip rather than being cut; and the video is a marker instead of
 *  an embed, because a wall of iframes is slow to load and impossible to skim.
 */
function FeedRow({ item }: { item: FeedItem }) {
  const venue = venueOf(item.venue);
  const isVideo = Boolean(youtubeId(item.url));

  return (
    <a
      className="feed-row"
      href={item.url}
      target="_blank"
      rel="noreferrer"
      title={item.snippet || item.headline}
    >
      <span className="feed-tag" style={{ color: venue.slot, borderColor: venue.slot }}>
        {venue.label}
      </span>
      <span className="feed-title">
        {isVideo && <span className="feed-video-mark" aria-label="video">▶</span>}
        {item.headline}
        {item.author && <span className="feed-by"> — {item.author}</span>}
      </span>
      {item.engagement != null && (
        <span className="feed-engagement">{item.engagement.toLocaleString()}</span>
      )}
      <span className="feed-date">{item.date ? fmtDate(item.date) : '—'}</span>
      {/* Second line: what was actually said. A headline alone tells you a post
          exists; this is the line that tells you whether it matters. Still one
          line — the rest stays on the row's tooltip — so the feed is scannable
          at two rows per item rather than six. */}
      {item.snippet && item.snippet !== item.headline && (
        <span className="feed-snippet">{plain(item.snippet ?? '')}</span>
      )}
    </a>
  );
}
