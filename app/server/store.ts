import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Scan } from '../shared/types.ts';

/** Scans are kept as one JSON file. The dashboard needs history across restarts,
 *  and at this volume a database would be ceremony. */
const FILE = path.resolve(import.meta.dirname, '../../data/scans.json');

let scans: Scan[] = load();

function load(): Scan[] {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8')) as Scan[];
  } catch {
    return [];
  }
}

function flush() {
  mkdirSync(path.dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(scans, null, 2));
}

/** The runs index. Bodies are stripped — the sidebar only needs the headline
 *  numbers, and a scan carries hundreds of excerpts. */
export const list = () =>
  scans.map(({ mentions, issues, abuse, log, ...rest }) => ({
    ...rest,
    mentions: [],
    issues: [],
    abuse: [],
    log: [],
    counts: {
      mentions: mentions.length,
      issues: issues.length,
      abuse: abuse?.length ?? 0,
      critical: (issues ?? []).filter((i) => i.severity === 'critical').length
        + (abuse ?? []).filter((a) => a.severity === 'critical').length,
    },
  }));

export const get = (id: string) => scans.find((s) => s.id === id);

export function put(scan: Scan) {
  const index = scans.findIndex((s) => s.id === scan.id);
  if (index === -1) scans.unshift(scan);
  else scans[index] = scan;
  flush();
  return scan;
}

export function patch(id: string, changes: Partial<Scan>) {
  const scan = get(id);
  if (!scan) return undefined;
  return put({ ...scan, ...changes });
}
