/** Searching a time window by writing the dates into the query.
 *
 *  The obvious way to search a window is the provider's freshness parameter,
 *  and it mostly does not exist: Brave takes an explicit `YYYY-MM-DDtoYYYY-MM-DD`
 *  range, Google takes `after:`/`before:` operators, and the rest take a choice
 *  of day, week, month or year and nothing else. Ask four providers for "March
 *  2026" and three of them quietly answer with everything.
 *
 *  So the window goes in as text. A page written on a date almost always says
 *  so on the page — a forum post header, a comment timestamp, a article byline
 *  — so `"Aug 1, 2026"` as a quoted phrase is a filter that every engine
 *  honours, because to the engine it is just a word to match. It is a bias
 *  rather than a guarantee, which is the honest description: it moves results
 *  toward the window instead of excluding everything outside it.
 *
 *  Both are used together. The parameter narrows where it is understood, the
 *  phrase biases everywhere, and the two are independent — a provider that
 *  ignores the parameter still sees the date in the text.
 *
 *  Formats matter more than they look. The same day is written
 *  `Aug 1, 2026` on one site, `August 1, 2026` on another, `1 August 2026` on a
 *  third and `2026-08-01` on a fourth, and a page carries whichever its
 *  template chose. Several are emitted per day for that reason; they are cheap
 *  as query text and each one reaches a different set of pages.
 */

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const MS_DAY = 86_400_000;

/** Every way a page is likely to print one day. */
export function dayStrings(date: Date): string[] {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const d = date.getUTCDate();
  const long = MONTHS[m]!;
  const short = long.slice(0, 3);
  return [
    `${short} ${d}, ${y}`,
    `${long} ${d}, ${y}`,
    `${d} ${long} ${y}`,
    `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
  ];
}

/** How a page is likely to print a month. */
export function monthStrings(date: Date): string[] {
  const y = date.getUTCFullYear();
  const long = MONTHS[date.getUTCMonth()]!;
  return [`${long} ${y}`, `${long.slice(0, 3)} ${y}`];
}

export interface WindowQueries {
  queries: string[];
  /** What was actually done, for the run log. A search strategy that changes
   *  shape depending on the span has to say which shape it took. */
  note: string;
}

/** Queries aimed at one source over one window.
 *
 *  `hosts` empty means the venue has no sites to aim at, and the queries go out
 *  unscoped — still useful, because the date phrase is doing most of the work.
 *
 *  Day-by-day for a short window, month-by-month for a long one. The crossover
 *  is at six weeks: below it a day per query is a few dozen searches and the
 *  precision is worth it; above it the same approach is hundreds of searches to
 *  fill a band that a month phrase covers nearly as well.
 */
export function windowQueries(
  brand: string,
  hosts: string[],
  from: string,
  to: string,
): WindowQueries {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end < start) {
    return { queries: [], note: `ignored an unusable window (${from} to ${to})` };
  }

  const days = Math.round((end.getTime() - start.getTime()) / MS_DAY) + 1;
  const byDay = days <= 45;

  const phrases: string[] = [];
  if (byDay) {
    for (let at = new Date(start); at <= end; at.setUTCDate(at.getUTCDate() + 1)) {
      phrases.push(...dayStrings(at));
    }
  } else {
    const at = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    for (let guard = 0; at <= end && guard < 400; guard += 1) {
      phrases.push(...monthStrings(at));
      at.setUTCMonth(at.getUTCMonth() + 1);
    }
  }

  // `after:`/`before:` alongside the phrase, for the engines that read
  // operators. Harmless to the ones that do not: they treat it as a word that
  // matches nothing much, and the quoted date is what carries those.
  const bounds = `after:${from} before:${to}`;

  const scoped = hosts.length ? hosts.map((host) => `site:${host} `) : [''];
  const queries = [...new Set(
    scoped.flatMap((prefix) => phrases.map((phrase) => `${prefix}${brand} "${phrase}" ${bounds}`)),
  )];

  return {
    queries,
    note: `${queries.length} dated queries across ${days} day${days === 1 ? '' : 's'}`
      + ` (${byDay ? 'day by day' : 'month by month'})`
      + (hosts.length ? ` on ${hosts.join(', ')}` : ' unscoped'),
  };
}
