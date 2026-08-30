/** Reading a codebase, deterministically, so an agent can diagnose against it.
 *
 *  The same split as everywhere else in this pipeline: code goes and finds the
 *  relevant source, the model reasons over what it was handed. There is no tool
 *  loop here and an agent is never given a shell — partly because a tool-calling
 *  loop over a 200MB C codebase is slow and unreliable, and partly because
 *  "grep for these symbols" is a fixed operation that does not need a model to
 *  decide it.
 *
 *  What makes this tractable is that a bug report contains its own search terms.
 *  A person writing "crashes when choosing Legacy Icons in Preferences" has
 *  named the UI strings and the subsystem; those strings are in the source,
 *  usually in a translatable literal, and finding them lands within a file or
 *  two of the defect.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface CodeHit {
  file: string;
  line: number;
  /** The matched line and a little context either side. */
  snippet: string;
  /** Which search term found it, so a diagnosis can say why a file is relevant. */
  term: string;
}

/** Words too common in any codebase to be worth searching for. A term like
 *  "error" matches tens of thousands of lines and drowns the specific ones. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'when', 'from', 'have', 'has', 'not', 'but',
  'crash', 'crashes', 'crashed', 'bug', 'issue', 'error', 'fail', 'fails', 'failed', 'problem',
  'user', 'users', 'app', 'application', 'software', 'program', 'version', 'reported', 'report',
  'work', 'works', 'working', 'broken', 'using', 'used', 'file', 'files', 'data', 'time',
]);

/** Search terms lifted out of a bug report.
 *
 *  Quoted phrases first — a reporter quoting a menu item has handed over an
 *  exact string that is almost certainly in the source. Then capitalised
 *  multi-word phrases, which are how UI labels read. Then distinctive single
 *  words. */
export function termsFromIssue(text: string): string[] {
  const terms: string[] = [];

  for (const match of text.matchAll(/["“”']([^"“”']{4,40})["“”']/g)) terms.push(match[1]!.trim());
  for (const match of text.matchAll(/\b([A-Z][a-z]+(?: [A-Z][a-z]+){1,3})\b/g)) terms.push(match[1]!);
  for (const match of text.matchAll(/\b([a-z]+(?:[-_][a-z]+)+)\b/gi)) terms.push(match[1]!);
  for (const match of text.matchAll(/\b([a-z]+_[a-z_]+)\b/gi)) terms.push(match[1]!);

  const words = text
    .split(/[^A-Za-z0-9_-]+/)
    .filter((word) => word.length >= 5 && !STOPWORDS.has(word.toLowerCase()));
  terms.push(...words);

  const seen = new Set<string>();
  return terms
    .map((term) => term.trim())
    .filter((term) => {
      const key = term.toLowerCase();
      if (!term || seen.has(key) || STOPWORDS.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 14);
}

/** Paths that mention everything and explain nothing.
 *
 *  A changelog for a thirty-year-old project contains every feature name ever
 *  shipped, so it matches any search term taken from a bug report and matches
 *  it dozens of times. Left in, the ranking put ChangeLog and COPYING above
 *  actual source. Translations are excluded for the same reason — every UI
 *  string appears in ninety .po files. */
const EXCLUDES = [
  '!po*/**', '!*.po', '!*.pot', '!**/ChangeLog*', '!**/NEWS*', '!COPYING*', '!AUTHORS*',
  '!**/*.md', '!**/*.txt', '!docs/**', '!**/tests/**', '!**/*.svg', '!**/*.xcf',
  '!**/*.png', '!**/*.json', '!**/*.xml', '!**/*.html',
];

/** Every match for one term, bounded per file so a single noisy file cannot
 *  crowd out the others.
 *
 *  Note that ripgrep's --max-count is PER FILE, not overall — reading it as a
 *  global cap and then taking the first N lines of output sorted the results
 *  alphabetically by path and returned whatever happened to live near the top
 *  of the tree. */
async function grep(repo: string, term: string, perFile: number, cap: number): Promise<CodeHit[]> {
  try {
    const { stdout } = await run('rg', [
      '--fixed-strings', '--ignore-case', '--line-number', '--with-filename',
      '--max-count', String(perFile),
      ...EXCLUDES.flatMap((glob) => ['--glob', glob]),
      term, '.',
    ], { cwd: repo, maxBuffer: 8 * 1024 * 1024, timeout: 30_000 });

    const rows = stdout.split('\n').filter(Boolean);

    // A term matching thousands of lines is a common word, not a clue. Skip it
    // rather than letting it flood the ranking with one arbitrary slice.
    if (rows.length > cap * 8) return [];

    return rows.slice(0, cap).map((row) => {
      const [file, lineNo, ...rest] = row.split(':');
      return {
        file: (file ?? '').replace(/^\.\//, ''),
        line: Number(lineNo) || 0,
        snippet: rest.join(':').trim().slice(0, 300),
        term,
      };
    });
  } catch {
    // rg exits non-zero when there are no matches, which is not an error here.
    return [];
  }
}

/** Files whose PATH contains the term.
 *
 *  Cheap and disproportionately effective. Projects name files after the thing
 *  they implement, so a report mentioning "Preferences" and "Icons" points
 *  straight at app/dialogs/preferences-dialog.c and app/gui/icon-themes.c —
 *  neither of which content search ranked highly, because the words appear in
 *  hundreds of files and those two are not where they appear most.
 *
 *  It also covers the case that defeated content search here: a UI label the
 *  program reads from disk rather than hard-coding has no string literal to
 *  find, but the subsystem that reads it is still named after it. */
async function grepPaths(repo: string, term: string, cap: number): Promise<CodeHit[]> {
  const needle = term.toLowerCase().replace(/\s+/g, '');
  if (needle.length < 4) return [];
  try {
    const { stdout } = await run('rg', ['--files', ...EXCLUDES.flatMap((g) => ['--glob', g])], {
      cwd: repo, maxBuffer: 8 * 1024 * 1024, timeout: 30_000,
    });
    return stdout.split('\n')
      .filter(Boolean)
      .map((file) => file.replace(/^\.\//, ''))
      .filter((file) => file.toLowerCase().replace(/[^a-z0-9/.]/g, '').includes(needle))
      // Shallower paths first. A project's own implementation of a thing sits
      // nearer the top of the tree than the eleventh plug-in that also uses it.
      .sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length)
      .slice(0, cap)
      .map((file) => ({ file, line: 1, snippet: `(filename matches "${term}")`, term }));
  } catch {
    return [];
  }
}

/** Everything in the checkout that looks related to this report. */
export async function findRelevantCode(
  repo: string, issueText: string, opts: { perTerm?: number; maxHits?: number } = {},
): Promise<{ terms: string[]; hits: CodeHit[] }> {
  if (!existsSync(repo)) throw new Error(`no checkout at ${repo}`);

  const terms = termsFromIssue(issueText);
  const perTerm = opts.perTerm ?? 6;
  const hits: CodeHit[] = [];

  for (const term of terms) {
    hits.push(...await grepPaths(repo, term, 12));
    hits.push(...await grep(repo, term, 3, perTerm * 4));
    if (hits.length >= (opts.maxHits ?? 120)) break;
  }

  return { terms, hits: hits.slice(0, opts.maxHits ?? 120) };
}

/** The files that matched most, which is a decent proxy for "where this lives". */
/** Implementation files outrank data and build files. A .desktop template or a
 *  default rc file can mention a feature by name without containing a line of
 *  the logic behind it. */
const SOURCE = /\.(c|h|cc|cpp|hpp|m|py|js|jsx|ts|tsx|go|rs|rb|java|kt|swift|cs|php|vala)$/i;

export function rankFiles(hits: CodeHit[], limit = 8): { file: string; matches: number; terms: string[] }[] {
  const byFile = new Map<string, { matches: number; terms: Set<string>; path: number }>();
  for (const hit of hits) {
    const row = byFile.get(hit.file) ?? { matches: 0, terms: new Set<string>(), path: 0 };
    row.matches += 1;
    row.terms.add(hit.term);
    if (hit.line === 1 && hit.snippet.startsWith('(filename matches')) row.path += 1;
    byFile.set(hit.file, row);
  }

  const score = (file: string, row: { matches: number; terms: Set<string>; path: number }) =>
    // Distinct terms dominate: a file matching four different words from the
    // report is far more likely to be the place than one matching a single word
    // forty times. A filename match is worth more than a body match, and source
    // beats data.
    row.terms.size * 10 + row.path * 8 + (SOURCE.test(file) ? 6 : 0) + Math.min(row.matches, 6);

  return [...byFile.entries()]
    .sort((a, b) => score(b[0], b[1]) - score(a[0], a[1]))
    .slice(0, limit)
    .map(([file, row]) => ({ file, matches: row.matches, terms: [...row.terms] }));
}

/** Source for the model to read: the whole file when it is small enough,
 *  otherwise a window around the match.
 *
 *  Windowing everything was a real failure, not a tuning detail. Asked to
 *  diagnose "you can't guess the letter q" against a 140-line hangman, the
 *  search correctly identified hangman.py — and then the window centred on the
 *  first match, which was the import block, so the model was shown the top of
 *  the file and none of the input handling. It answered `insufficient` and
 *  asked for "the full contents of hangman.py after the excerpt shown", which
 *  was the right answer to the wrong question.
 *
 *  Most files worth diagnosing fit in a few thousand tokens. Send the file. */
const WHOLE_FILE_LINES = 400;

export function excerpt(repo: string, file: string, line: number, radius = 40): string {
  try {
    const lines = readFileSync(path.join(repo, file), 'utf8').split('\n');
    const whole = lines.length <= WHOLE_FILE_LINES;
    const start = whole ? 0 : Math.max(0, line - radius);
    const end = whole ? lines.length : Math.min(lines.length, line + radius);
    const body = lines.slice(start, end)
      .map((text, index) => `${String(start + index + 1).padStart(5)}  ${text}`)
      .join('\n');
    return whole ? body : `… showing lines ${start + 1}-${end} of ${lines.length} …\n${body}`;
  } catch {
    return '';
  }
}
