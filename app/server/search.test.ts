/** you.com does not honour `site:`, so the operator is translated into its
 *  domain parameters before the request goes out. Every discovery query in this
 *  app is `site:`-shaped, and getting this wrong does not fail loudly — it
 *  fills the corpus with confident, unrelated results. Hence tests. */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { splitDomains } from './search.ts';

test('site: becomes an included domain and leaves the terms behind', () => {
  const { query, include, exclude } = splitDomains('site:reddit.com bolt.new bug');
  assert.equal(query, 'bolt.new bug');
  assert.deepEqual(include, ['reddit.com']);
  assert.deepEqual(exclude, []);
});

test('-site: becomes an exclusion', () => {
  const { query, include, exclude } = splitDomains('gimp crash -site:gimp.org');
  assert.equal(query, 'gimp crash');
  assert.deepEqual(include, []);
  assert.deepEqual(exclude, ['gimp.org']);
});

test('several operators anywhere in the query', () => {
  const { query, include, exclude } = splitDomains('site:news.ycombinator.com replit -site:replit.com outage');
  assert.equal(query, 'replit outage');
  assert.deepEqual(include, ['news.ycombinator.com']);
  assert.deepEqual(exclude, ['replit.com']);
});

test('a host is normalised the way the API expects it', () => {
  assert.deepEqual(splitDomains('site:https://www.trustpilot.com/review/x reviews').include, ['trustpilot.com']);
});

test('a query with no operator is untouched', () => {
  const { query, include } = splitDomains('bolt.new complaints not working');
  assert.equal(query, 'bolt.new complaints not working');
  assert.deepEqual(include, []);
});

test('a bare site: query has nothing left to search for', () => {
  // The caller uses this to skip the provider rather than spend a request on
  // an empty query — you.com has no "recent pages on this host" mode.
  assert.equal(splitDomains('site:reddit.com').query, '');
});

/* --------------------------------------------------- subject disambiguation */

import { settlingTokens } from './pipeline.ts';

test('a name with a dot or a space settles the topic; a bare word does not', () => {
  const subject = { searchTerm: 'Bolt.new', name: 'Bolt.new', aliases: ['Bolt new'] };
  const tokens = settlingTokens('Bolt.new', 'https://bolt.new', subject as never);
  assert.ok(tokens.includes('bolt.new'));
  assert.ok(tokens.includes('bolt new'));
  assert.ok(!tokens.includes('bolt'), 'a bare "bolt" must not settle anything — it is the collision');
});

test('the site is normalised to a bare host', () => {
  const tokens = settlingTokens('GIMP', 'https://www.gimp.org/', { searchTerm: 'GIMP', name: 'GIMP', aliases: [] } as never);
  assert.ok(tokens.includes('gimp.org'));
  assert.ok(!tokens.includes('gimp'));
});

test('multi-word aliases count, short ones do not', () => {
  const tokens = settlingTokens('GIMP', '', {
    searchTerm: 'GIMP', name: 'GIMP', aliases: ['GNU Image Manipulation Program', 'GNU'],
  } as never);
  assert.deepEqual(tokens, ['gnu image manipulation program']);
});

/* ------------------------------------------------------------- languages */

import { LANGUAGES, complaintInAnyLanguage, enabledLanguages, queriesFor } from './languages.ts';

test('CJK complaints are recognised, which the English patterns cannot do', () => {
  assert.ok(complaintInAnyLanguage('Cursorが動かないので困っています', LANGUAGES));
  assert.ok(complaintInAnyLanguage('一直崩溃，用不了', LANGUAGES));
  assert.ok(complaintInAnyLanguage('로그인 오류가 계속 납니다', LANGUAGES));
});

test('Latin complaint words match on word boundaries, not as substrings', () => {
  assert.ok(complaintInAnyLanguage('la app no funciona desde ayer', LANGUAGES));
  // The failure this guards: `lento` inside `talento`, `falla` inside
  // `fallacy`. A substring test marks both as complaints.
  assert.ok(!complaintInAnyLanguage('un equipo con mucho talento', LANGUAGES));
  assert.ok(!complaintInAnyLanguage('that is a fallacy about the roadmap', LANGUAGES));
});

test('praise in another language is not a complaint', () => {
  assert.ok(!complaintInAnyLanguage('とても便利で気に入っています', LANGUAGES));
  assert.ok(!complaintInAnyLanguage('这个工具很好用', LANGUAGES));
});

test('every language runs unless a specific list narrows it', () => {
  assert.equal(enabledLanguages(undefined).length, LANGUAGES.length);
  assert.equal(enabledLanguages([]).length, LANGUAGES.length, 'empty must not mean English only');
  assert.deepEqual(enabledLanguages(['ja']).map((l) => l.code), ['ja']);
  assert.deepEqual(enabledLanguages(['nope']).map((l) => l.code), []);
});

test('a normal run spends less per language than a deep one', () => {
  const pack = LANGUAGES.find((l) => l.code === 'zh')!;
  const normal = queriesFor(pack, 'Bolt.new', false);
  const deep = queriesFor(pack, 'Bolt.new', true);
  assert.ok(normal.length < deep.length);
  assert.ok(normal.some((q) => q.includes('崩溃')));
  assert.ok(normal.some((q) => q.startsWith('site:')));
  assert.equal(new Set(deep).size, deep.length, 'no duplicate queries');
});

/* ------------------------------------------------- repairing model JSON */

import { escapeControlChars } from './model.ts';

const repairs = (broken: string) => {
  assert.throws(() => JSON.parse(broken), 'the fixture should be broken to begin with');
  return JSON.parse(escapeControlChars(broken)) as Record<string, unknown>;
};

test('a raw newline inside a string is escaped', () => {
  assert.deepEqual(repairs('{"a":"one\ntwo"}'), { a: 'one\ntwo' });
  assert.deepEqual(repairs('{"a":"one\ttwo"}'), { a: 'one\ttwo' });
});

test('an unescaped quote inside a string does not desync the parser', () => {
  // The failure this guards: toggling on every quote put the scanner outside
  // the string, so the newline further on was read as whitespace and left —
  // and a repaired document still failed with "Bad control character".
  assert.deepEqual(
    repairs('{"a":"he said "hi" then\nleft"}'),
    { a: 'he said "hi" then\nleft' },
  );
});

test('a backslash that is not a valid escape is taken literally', () => {
  assert.deepEqual(repairs('{"a":"C:\\path\nnext"}'), { a: 'C:\\path\nnext' });
});

test('valid JSON is left exactly as it was', () => {
  const good = '{"a":"quoted \\"thing\\"","b":[1,2],"c":"line\\nbreak","d":"slash\\\\"}';
  assert.equal(escapeControlChars(good), good);
  assert.deepEqual(JSON.parse(escapeControlChars(good)), JSON.parse(good));
});

test('a real buzz-shaped payload survives both faults at once', () => {
  const broken = '{"scored":[{"index":0,"sentiment":"negative","score":-0.8,'
    // `\p` is not a JSON escape; `\t` would be, and is left as a tab.
    + '"themes":["the "preview" pane\nfreezes","C:\\proj"]}]}';
  const out = repairs(broken) as { scored: { themes: string[] }[] };
  assert.deepEqual(out.scored[0]!.themes, ['the "preview" pane\nfreezes', 'C:\\proj']);
});

/* ------------------------------------------------------ error reporting */

import { describeError } from './errors.ts';

test('a bare "fetch failed" gains the reason hidden on its cause', () => {
  // Exactly what undici throws: the two useless words on top, everything that
  // matters one link down.
  const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), {
    code: 'ECONNREFUSED',
  });
  const error = Object.assign(new TypeError('fetch failed'), { cause });

  const said = describeError(error);
  assert.match(said, /fetch failed/, 'keeps the original wording');
  assert.match(said, /ECONNREFUSED 127\.0\.0\.1:11434/, 'names the address');
  assert.match(said, /nothing is listening there/, 'says what to do about it');
});

test('an AggregateError reports what its members failed with', () => {
  const inner = Object.assign(new Error('connect EHOSTUNREACH 10.0.0.5:443'), { code: 'EHOSTUNREACH' });
  const error = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new AggregateError([inner], 'all attempts failed'), {}),
  });
  assert.match(describeError(error), /EHOSTUNREACH|no route to that host/);
});

test('an ordinary error is passed through unchanged', () => {
  assert.equal(describeError(new Error('no GITHUB_TOKEN')), 'no GITHUB_TOKEN');
  assert.equal(describeError('plain string'), 'plain string');
  assert.equal(describeError(undefined), 'unknown error');
});

test('a repeated message is not printed twice', () => {
  const error = Object.assign(new Error('boom'), { cause: new Error('boom') });
  assert.equal(describeError(error), 'boom');
});

test('a cause cycle does not hang', () => {
  const a: { message: string; cause?: unknown } = { message: 'a' };
  const b = { message: 'b', cause: a };
  a.cause = b;
  assert.match(describeError(Object.assign(new Error('a'), { cause: b })), /b/);
});
