import { useState } from 'react';
import type { Drop, VenueAudit } from '../../../shared/types.ts';
import { STAGES } from '../../../shared/types.ts';

/** What happened to one source, in the order it happened.
 *
 *  The coverage grid can show a dark band. It cannot say which of four very
 *  different things the band means, and the response to each is different:
 *
 *    - nothing was returned          then the query list or the provider is the problem
 *    - things were returned and cut  then our own filter is the problem
 *    - a filter cut them for a reason that is wrong about this source
 *    - a cap cut them, meaning they were fine and lost a race against a number
 *
 *  The examples are the load-bearing part. A count of "31 dropped: nothing in
 *  the title or snippet names Replit" is a filter doing its job or a filter
 *  eating the venue, and the only way to tell is to look at three of the URLs
 *  it took. So they are listed, and they are links.
 */

const stageLabel = (stage: Drop['stage']) =>
  (stage === 'unknown' ? 'unknown stage' : STAGES.find((s) => s.key === stage)?.label ?? stage);

export function Why({ audit, kept, label, onDig, diggable }: {
  audit: VenueAudit | null;
  /** How many of this source's results are in the corpus now. */
  kept: number;
  label: string;
  onDig?: () => void;
  diggable: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);

  const returned = audit?.returned ?? 0;
  const drops = audit?.drops ?? [];
  const cut = drops.reduce((sum, drop) => sum + drop.count, 0);

  // The headline sentence, which is the whole point of the panel: one plain
  // statement of which of the four situations this is.
  const verdict = (() => {
    if (!audit) {
      return 'No accounting was recorded for this source — the scan predates this panel, or the '
        + 'stage that would have filled it has not been run since.';
    }
    if (returned === 0 && cut === 0) {
      return `Search returned nothing at all for ${label}. Either no query was aimed at it, or the `
        + 'providers in the chain do not index it.';
    }
    if (kept === 0 && cut > 0) {
      return `Search returned ${returned} result${returned === 1 ? '' : 's'} for ${label} and every `
        + 'one was dropped. This gap is ours, not the internet’s.';
    }
    if (cut === 0) {
      return `Search returned ${returned}, and nothing was dropped. This is what ${label} has.`;
    }
    return `Search returned ${returned} for ${label}; ${kept} are in the corpus and ${cut} `
      + 'were dropped.';
  })();

  return (
    <div className="why">
      <p className="why-verdict">{verdict}</p>

      {drops.length > 0 && (
        <ul className="why-drops">
          {drops.map((drop) => {
            const key = `${drop.stage} ${drop.reason}`;
            const showing = open === key;
            return (
              <li key={key}>
                <button className="why-drop" onClick={() => setOpen(showing ? null : key)}>
                  <span className="why-n">{drop.count}</span>
                  <span className="why-reason">{drop.reason}</span>
                  <span className="conn-meta">{stageLabel(drop.stage)}</span>
                  <span className="tag plain">{showing ? 'hide' : `see ${Math.min(drop.examples.length, drop.count)}`}</span>
                </button>

                {showing && (
                  <ul className="why-examples">
                    {drop.examples.map((example) => (
                      <li key={example.url}>
                        <a href={example.url} target="_blank" rel="noreferrer">
                          {example.title || example.url}
                        </a>
                        <span className="why-url">{example.url}</span>
                      </li>
                    ))}
                    {drop.count > drop.examples.length && (
                      <li className="q">
                        {drop.count - drop.examples.length} more not kept as examples.
                      </li>
                    )}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {diggable && onDig && (
        <button className="why-dig" onClick={onDig}>Search {label} harder</button>
      )}
    </div>
  );
}
