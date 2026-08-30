/** Everything the system would have said to a real person, kept instead of sent.
 *
 *  The product's whole point is closing the loop with the person who complained
 *  — acknowledge it, file it, fix it, tell them. During development that last
 *  step must not actually happen: these are strangers who did not ask to be
 *  contacted, and a bug in the draft logic would be published under the
 *  company's name in a public thread.
 *
 *  Discarding the drafts is the wrong answer too. "What would we have posted?"
 *  is the question that tells you whether the replies are any good, and it can
 *  only be answered if they are written down as they are produced. So drafts go
 *  here: addressed, timestamped, attributed to the issue they came from, and
 *  never delivered.
 *
 *  Turning delivery on later means reading from this file rather than inventing
 *  a new path — the outbox already holds exactly what would go out.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Issue, Scan } from '../shared/types.ts';

const FILE = path.resolve(import.meta.dirname, '../../data/outbox.json');

export interface OutboxEntry {
  id: string;
  at: string;
  /** What this would have been: a public reply, a follow-up, a ticket comment. */
  kind: 'reply' | 'follow-up' | 'ticket-comment';
  scanId: string;
  issueId: string;
  issueTitle: string;
  company: string;
  /** Where it would have gone, in the venue's own terms. */
  destination: string;
  /** The handle it was addressed to, when one was identified. */
  recipient?: string;
  /** The thread it would have been posted in. */
  sourceUrl?: string;
  /** The message itself, verbatim and unabridged. */
  message: string;
  /** Why it was not sent. Always populated while delivery is off, so nobody
   *  reading this file later mistakes an undelivered draft for a sent one. */
  heldBecause: string;
  status: 'held' | 'sent' | 'discarded';
}

function load(): OutboxEntry[] {
  try {
    return existsSync(FILE) ? (JSON.parse(readFileSync(FILE, 'utf8')) as OutboxEntry[]) : [];
  } catch {
    return [];
  }
}

function save(entries: OutboxEntry[]): void {
  mkdirSync(path.dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(entries, null, 2));
}

/** Record a message that would have been sent. Returns the stored entry. */
export function hold(
  input: Omit<OutboxEntry, 'id' | 'at' | 'status'> & { status?: OutboxEntry['status'] },
): OutboxEntry {
  const entry: OutboxEntry = {
    ...input,
    id: randomUUID().slice(0, 8),
    at: new Date().toISOString(),
    status: input.status ?? 'held',
  };
  const entries = load();
  entries.unshift(entry);
  save(entries);
  return entry;
}

export const outbox = (scanId?: string): OutboxEntry[] => {
  const all = load();
  return scanId ? all.filter((e) => e.scanId === scanId) : all;
};

export function discard(id: string): boolean {
  const entries = load();
  const entry = entries.find((e) => e.id === id);
  if (!entry) return false;
  entry.status = 'discarded';
  save(entries);
  return true;
}

/** Convenience for the reply path, which is the only producer today. */
export const holdReply = (
  scan: Scan, issue: Issue, message: string, destination: string, kind: OutboxEntry['kind'],
): OutboxEntry =>
  hold({
    kind,
    scanId: scan.id,
    issueId: issue.id,
    issueTitle: issue.title,
    company: scan.company,
    destination,
    recipient: issue.reporter?.handle,
    sourceUrl: issue.reporter?.sourceUrl,
    message,
    heldBecause:
      'Delivery is off while this is in development. Nothing has been posted to the reporter; '
      + 'this is the exact text that would have been.',
  });
