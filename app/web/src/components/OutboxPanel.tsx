import { useEffect, useState } from 'react';
import { api, fmtDate } from '../lib.ts';

interface OutboxEntry {
  id: string;
  at: string;
  kind: 'reply' | 'follow-up' | 'ticket-comment';
  scanId: string;
  issueId: string;
  issueTitle: string;
  company: string;
  destination: string;
  recipient?: string;
  sourceUrl?: string;
  message: string;
  heldBecause: string;
  status: 'held' | 'sent' | 'discarded';
}

const KIND_LABEL: Record<OutboxEntry['kind'], string> = {
  reply: 'acknowledgement',
  'follow-up': 'fix follow-up',
  'ticket-comment': 'ticket comment',
};

/** Everything the system would have said to a real person, and did not.
 *
 *  This is the review surface for the part of the product that carries the most
 *  risk. These are drafts addressed to named strangers, to be posted in public
 *  under a company's name, and the only way to know whether they are any good
 *  is to read them before delivery is ever switched on.
 *
 *  Nothing here has been sent. Every entry says so on its face rather than in a
 *  footnote, because a list of messages that looks like an outbox is very easy
 *  to misread as one.
 */
export function OutboxPanel({ onClose }: { onClose?: () => void }) {
  const [entries, setEntries] = useState<OutboxEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = () => {
    api<OutboxEntry[]>('api/outbox')
      .then(setEntries)
      .catch((e) => setError(String(e).replace(/^Error:\s*/, '')));
  };

  useEffect(load, []);

  const discard = async (id: string) => {
    await api(`api/outbox/${id}/discard`, { method: 'POST', body: '{}' }).catch(() => {});
    load();
  };

  const held = (entries ?? []).filter((e) => e.status === 'held');

  return (
    <>
      {onClose && <button className="ghost back-to-scans" onClick={onClose}>← Back to scans</button>}

      <div className="rubric">
        <h2>Outbox</h2>
        <p>
          Replies drafted for the people who reported problems. <b>None of these have been sent.</b>{' '}
          Delivery is off while this is in development — posting in a company's name to a named
          stranger is the one step in the loop that cannot be taken back, so the drafts are kept here
          to be read instead.
        </p>
      </div>

      {error && <div className="set-message err" style={{ padding: '12px 16px' }}>{error}</div>}
      {entries === null && !error && <div className="set-loading">Loading…</div>}

      {entries && entries.length === 0 && (
        <div className="panel">
          <div className="empty">
            <h3>Nothing drafted yet</h3>
            <p>
              A reply lands here when you draft one from an issue in Health. Nothing writes to it
              automatically — the draft is produced when someone asks for it.
            </p>
          </div>
        </div>
      )}

      {entries && entries.length > 0 && (
        <div className="panel">
          <div className="set-head">
            <strong>{held.length} held</strong>
            <span className="tag plain">never delivered</span>
          </div>
          <div className="conn-list">
            {entries.map((entry) => (
              <div key={entry.id}>
                <button className="conn-row agent-row" onClick={() => setOpen(open === entry.id ? null : entry.id)}>
                  <span className="conn-dot" data-status={entry.status === 'held' ? 'unconfigured' : 'planned'} />
                  <span className="conn-name">
                    {entry.recipient ? `@${entry.recipient.replace(/^@+/, '')}` : entry.destination}
                    <span className="agent-desc"> — {entry.issueTitle}</span>
                  </span>
                  <span className={`tag ${entry.status === 'held' ? 'warning' : 'plain'}`}>{entry.status}</span>
                  <span className="conn-meta">{KIND_LABEL[entry.kind]} · {fmtDate(entry.at)}</span>
                </button>

                {open === entry.id && (
                  <div className="source-result" style={{ margin: '0 16px 14px' }}>
                    <dl className="agent-detail">
                      <dt>company</dt><dd>{entry.company}</dd>
                      <dt>would go to</dt><dd>{entry.destination}</dd>
                      {entry.sourceUrl && (
                        <><dt>thread</dt>
                          <dd><a href={entry.sourceUrl} target="_blank" rel="noreferrer">{entry.sourceUrl}</a></dd></>
                      )}
                      <dt>held because</dt><dd>{entry.heldBecause}</dd>
                    </dl>
                    <h6>The message, verbatim</h6>
                    <p className="reply">{entry.message}</p>
                    {entry.status === 'held' && (
                      <div className="actions">
                        <button onClick={() => discard(entry.id)}>Discard this draft</button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
