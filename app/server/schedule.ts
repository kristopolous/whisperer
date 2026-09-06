/** Run the watch on a timer.
 *
 *  Reputation is a series — a defect that is new this morning, a score that
 *  slid over a fortnight — and a series needs observations taken without
 *  somebody remembering to take them. This is the part that remembers.
 *
 *  Deliberately a timer inside the API process rather than a daemon or a
 *  systemd unit. It lives exactly as long as the server you started, it is
 *  listed over the API with its next and last run, and stopping the server
 *  stops it. A schedule you cannot see is worse than no schedule: it runs
 *  whatever code was on disk when it started, forever, and every question about
 *  why the numbers moved has an invisible extra suspect in it.
 *
 *  Nothing is enabled by default. An entry has to be switched on.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Scan } from '../shared/types.ts';
import { cleanName, siteOf } from '../shared/name.ts';
import { performScan } from './run.ts';
import * as store from './store.ts';

const FILE = path.resolve(import.meta.dirname, '../../data/schedule.json');

export type Cadence = 'daily' | 'weekly';

export interface ScheduleEntry {
  id: string;
  /** What to scan — the same string somebody would type into the box. */
  input: string;
  cadence: Cadence;
  /** Local hour of day to run at, 0–23. */
  hour: number;
  enabled: boolean;
  /** How hard the scheduled run looks. A weekly run is the natural place for a
   *  deep sweep; a daily one usually is not. */
  deep?: boolean;
  lastRunAt?: string;
  lastScanId?: string;
  lastOutcome?: 'done' | 'error' | 'cancelled';
  lastError?: string;
  /** What the run produced, so the list says whether the automation is working
   *  rather than only that it fired. */
  lastFound?: { mentions: number; issues: number };
}

let entries: ScheduleEntry[] = load();

function load(): ScheduleEntry[] {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8')) as ScheduleEntry[];
  } catch {
    return [];
  }
}

function flush() {
  mkdirSync(path.dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(entries, null, 2));
}

/** When this entry should next run, given when it last did.
 *
 *  Computed rather than stored, so editing the hour takes effect immediately
 *  and a stored `nextRun` can never drift out of agreement with the cadence it
 *  was derived from. */
export function nextRun(entry: ScheduleEntry, from = new Date()): Date {
  const next = new Date(from);
  next.setHours(entry.hour, 0, 0, 0);
  const step = entry.cadence === 'weekly' ? 7 : 1;
  // Already past today's slot, or already run in it.
  const ran = entry.lastRunAt ? new Date(entry.lastRunAt) : null;
  while (next <= from || (ran && next <= ran)) next.setDate(next.getDate() + step);
  return next;
}

const due = (entry: ScheduleEntry, now: Date): boolean => {
  if (!entry.enabled) return false;
  if (!entry.lastRunAt) {
    // Never run: due at the next occurrence of its hour, not immediately.
    // Enabling a schedule should not kick off a scan you did not ask for.
    const slot = new Date(now);
    slot.setHours(entry.hour, 0, 0, 0);
    return now >= slot && now.getTime() - slot.getTime() < 12 * 60 * 60 * 1000;
  }
  return now >= nextRun(entry, new Date(entry.lastRunAt));
};

/** A fresh scan record for a scheduled run.
 *
 *  A new id every time, because a run is an observation and overwriting the
 *  previous one destroys the comparison that makes either of them mean
 *  anything. The static work — the resolved subject and the footprint — is
 *  carried forward from the last run that had it, which is what stops the daily
 *  scan re-deriving a company's identity every morning. */
function mint(input: string): Scan {
  const previous = [...store.list()]
    .map((row) => store.get(row.id))
    .find((scan): scan is Scan =>
      Boolean(scan) && !scan!.fixture
      && (scan!.input === input || scan!.company.toLowerCase() === cleanName(input).toLowerCase()));

  const carried = previous
    ? [...store.history(previous.id)].reverse().find((run) => (run.profiles?.length ?? 0) > 0)
    : undefined;

  return {
    id: randomUUID().slice(0, 8),
    input,
    company: carried?.company ?? cleanName(input),
    site: carried?.site ?? siteOf(input),
    createdAt: new Date().toISOString(),
    status: 'running',
    stage: 'queued',
    ...(carried?.subject ? { subject: carried.subject } : {}),
    languages: carried?.languages ?? [],
    profiles: carried?.profiles ?? [],
    mentions: [], issues: [], abuse: [], buzz: [], topics: [], migrations: [],
    reviews: [], feed: [], log: [], timings: {},
    verdict: '',
    net: { now: 0, delta: 0 },
  } as Scan;
}

/** Only ever one scheduled run at a time.
 *
 *  The search budget and the provider pacers are per process, so two scans in
 *  parallel spend each other's allowance and then both report a thin corpus.
 *  A queue of one is also enough: these are daily jobs, and a run takes
 *  minutes. */
let running: string | null = null;

export const runningNow = (): string | null => running;

async function fire(entry: ScheduleEntry) {
  const scan = mint(entry.input);
  scan.depth = entry.deep ? 'deep' : 'normal';
  store.put(scan);

  const lock = store.claim(scan.id, 'scheduled scan');
  if (!lock.ok) return;

  running = entry.id;
  entry.lastRunAt = new Date().toISOString();
  entry.lastScanId = scan.id;
  flush();

  try {
    // Events go nowhere: nobody is watching a 6am run. The record it leaves in
    // the store is the output, and the series reads it from there.
    const outcome = await performScan(scan, () => {});
    entry.lastOutcome = outcome;
    entry.lastError = outcome === 'error' ? scan.error : undefined;
    entry.lastFound = { mentions: scan.mentions.length, issues: scan.issues.length };
  } catch (error) {
    entry.lastOutcome = 'error';
    entry.lastError = error instanceof Error ? error.message.slice(0, 300) : String(error);
  } finally {
    store.release(scan.id, 'scheduled scan');
    running = null;
    flush();
  }
}

let timer: NodeJS.Timeout | null = null;

/** Check every minute. Cheap, and it means an entry edited at 05:59 runs at
 *  06:00 rather than at whatever offset the process happened to start on. */
export function startScheduler() {
  if (timer) return;
  timer = setInterval(() => {
    if (running) return;
    const now = new Date();
    const next = entries.find((entry) => due(entry, now));
    if (next) void fire(next);
  }, 60_000);
  // Do not hold the process open on the timer's account.
  timer.unref?.();
}

export const listSchedule = (): (ScheduleEntry & { nextRunAt: string | null })[] =>
  entries.map((entry) => ({
    ...entry,
    nextRunAt: entry.enabled ? nextRun(entry).toISOString() : null,
  }));

export function upsert(entry: Partial<ScheduleEntry> & { input: string }): ScheduleEntry {
  const existing = entries.find((e) => e.id === entry.id || e.input === entry.input);
  const merged: ScheduleEntry = {
    id: existing?.id ?? randomUUID().slice(0, 8),
    input: entry.input,
    cadence: entry.cadence ?? existing?.cadence ?? 'daily',
    hour: Math.min(23, Math.max(0, entry.hour ?? existing?.hour ?? 6)),
    enabled: entry.enabled ?? existing?.enabled ?? false,
    deep: entry.deep ?? existing?.deep ?? false,
    lastRunAt: existing?.lastRunAt,
    lastScanId: existing?.lastScanId,
    lastOutcome: existing?.lastOutcome,
    lastError: existing?.lastError,
    lastFound: existing?.lastFound,
  };
  entries = [...entries.filter((e) => e.id !== merged.id), merged];
  flush();
  return merged;
}

export function removeEntry(id: string): boolean {
  const before = entries.length;
  entries = entries.filter((entry) => entry.id !== id);
  flush();
  return entries.length !== before;
}
