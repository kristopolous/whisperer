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

const TLD = /\.(com|co\.uk|co|org|net|io|dev|app|ai|me|us|xyz|site|news|blog|company|social)$/i;
const SECOND_LEVEL = /\.(co\.uk|com\.au|co\.nz|co\.in|com\.br|co\.jp|com\.mx|org\.uk|gov\.uk)$/i;

/** A canonical grouping key for a scan's subject, so "supabase", "supabase.com"
 *  and "https://www.supabase.com/" all collapse to the same company. Keyed off
 *  the resolved site when we have one, else the raw company string. */
function companyKey(scan: Scan): string {
  const source = (scan.site || scan.company || '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[/?#]/)[0].trim().toLowerCase();
  if (!source) return '';
  let host = source;
  if (SECOND_LEVEL.test(host)) host = host.replace(SECOND_LEVEL, '');
  else if (TLD.test(host)) host = host.replace(TLD, '');
  else host = host.split('.')[0];
  return host;
}

/** The runs index. Bodies are stripped — the sidebar only needs the headline
 *  numbers, and a scan carries hundreds of excerpts.
 *
 *  Collapses to one entry per company: a company is frequently re-scanned (or a
 *  scan crashes and is retried), so the dashboard should show the single, most
 *  recent useful run rather than a row per attempt. "supabase.com", "supabase"
 *  and a pasted URL all count as the same company. */
export const list = () => {
  const newest = [...scans].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const seen = new Set<string>();
  const out: ReturnType<typeof summarize>[] = [];
  for (const scan of newest) {
    const key = companyKey(scan);
    if (!key || seen.has(key)) continue;
    if (scan.status === 'running') {
      // Don't surface a stuck or in-progress run as the company's entry when a
      // settled (done/error) scan for the same company already exists.
      const settled = newest.some((s) => companyKey(s) === key && s.status !== 'running');
      if (settled) continue;
    }
    seen.add(key);
    out.push(summarize(scan));
  }
  return out;
};

/** The headline numbers for one scan, with the chatty bodies stripped. */
function summarize({ mentions, issues, abuse, log, ...rest }: Scan) {
  void log;
  return {
    ...rest,
    mentions: [],
    issues: [],
    abuse: [],
    log: [],
    counts: {
      mentions: mentions.length,
      // How many mentions carry a judgement. The sidebar shows a net sentiment
      // per run, and without this it cannot tell "neutral" from "never scored"
      // — so every failed scoring pass showed as a confident +0.00.
      scored: mentions.filter((m) => m.scored ?? (m.score !== 0 || m.sentiment !== 'neutral')).length,
      issues: issues.length,
      abuse: abuse?.length ?? 0,
      critical: (issues ?? []).filter((i) => i.severity === 'critical').length
        + (abuse ?? []).filter((a) => a.severity === 'critical').length,
    },
  };
}

export const get = (id: string) => scans.find((s) => s.id === id);

export function put(scan: Scan) {
  const index = scans.findIndex((s) => s.id === scan.id);
  if (index === -1) scans.unshift(scan);
  else scans[index] = scan;
  flush();
  return scan;
}

/** Delete a scan and every other attempt at the same company.
 *
 *  The sidebar collapses re-scans into one row per company, so a row does not
 *  stand for one record — removing only the scan behind it would make an older
 *  attempt at the same company pop straight back into the list, which reads as
 *  the delete having failed. What the row means is "this company", so that is
 *  what goes.
 *
 *  Returns the ids actually removed, so the caller can say what happened rather
 *  than claiming a single deletion.
 */
export function remove(id: string): string[] {
  const target = get(id);
  if (!target) return [];

  const key = companyKey(target);
  const doomed = scans.filter((scan) => scan.id === id || (key && companyKey(scan) === key));
  const ids = new Set(doomed.map((scan) => scan.id));

  scans = scans.filter((scan) => !ids.has(scan.id));
  flush();
  return [...ids];
}

export function patch(id: string, changes: Partial<Scan>) {
  const scan = get(id);
  if (!scan) return undefined;
  return put({ ...scan, ...changes });
}
