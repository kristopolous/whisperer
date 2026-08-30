import type { FeedItem, Scan } from '../../../shared/types.ts';
import { fmtDate, venueOf } from '../lib.ts';

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
  const items = scan.feed ?? [];

  if (items.length === 0) {
    return (
      <div className="panel">
        <div className="empty">
          <h3>Nothing in the feed yet</h3>
        </div>
      </div>
    );
  }

  return (
    <div className="panel feed">
      {items.map((item) => (
        <FeedRow key={item.id} item={item} />
      ))}
    </div>
  );
}

function FeedRow({ item }: { item: FeedItem }) {
  const venue = venueOf(item.venue);
  const video = youtubeId(item.url);

  return (
    <div className="feed-row">
      <div className="feed-main">
        <div className="feed-head">
          <span className="feed-source" style={{ color: venue.slot }}>
            {venue.label}
          </span>
          {item.date && <span className="feed-date">{fmtDate(item.date)}</span>}
          {item.engagement != null && (
            <span className="feed-engagement">{item.engagement.toLocaleString()}</span>
          )}
        </div>
        <div className="feed-headline">{item.headline}</div>
        {item.author && <div className="feed-author">by {item.author}</div>}
        {item.snippet && (
          <div className="feed-comment">
            {item.snippet}
          </div>
        )}
        <div className="feed-actions">
          <a className="feed-link" href={item.url} target="_blank" rel="noreferrer">
            Open in {venue.label} ↗
          </a>
        </div>
      </div>
      {video && (
        <div className="feed-video">
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${video}`}
            title={item.headline}
            loading="lazy"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        </div>
      )}
    </div>
  );
}