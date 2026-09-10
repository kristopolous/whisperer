/** Every fixture is a real string from a real scan, kept verbatim.
 *
 *  The danger with a markdown stripper is not that it misses something; it is
 *  that it quietly edits somebody's words. So the cases that matter most here
 *  are the ones asserting that ordinary prose comes back unchanged.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { stripMarkdown } from './markdown.ts';

test('a link that is its own URL is printed once, not twice', () => {
  const real = 'I got impacted by this known Replit issue - '
    + '[https://status.replit.com/incidents/f551e79f](https://status.replit.com/incidents/f551e79f)';
  assert.equal(
    stripMarkdown(real),
    'I got impacted by this known Replit issue - https://status.replit.com/incidents/f551e79f',
  );
});

test('a link with a label keeps the label', () => {
  assert.equal(stripMarkdown('see [the status page](https://status.replit.com)'), 'see the status page');
});

test('headings lose the marker and keep the words', () => {
  // Dropping the line would delete content, which is not this function's job.
  assert.equal(
    stripMarkdown('# Replit Status\n## Is Replit down?\n### Top reported issues'),
    'Replit Status\nIs Replit down?\nTop reported issues',
  );
});

test('an issue reference is not a heading', () => {
  // From a real feed snippet. `#` only counts at the start of a line.
  assert.equal(
    stripMarkdown('Apply migration `0036_mistral.py` (from #498) against the **production** database'),
    'Apply migration 0036_mistral.py (from #498) against the production database',
  );
});

test('identifiers survive, because a single underscore is left alone', () => {
  // `_italic_` and `URL_DATABASE` are indistinguishable in a bug report, and
  // mangling an identifier inside a defect quote is the worse error.
  assert.equal(stripMarkdown('the URL_DATABASE issue and __init__ and snake_case_name'),
    'the URL_DATABASE issue and __init__ and snake_case_name');
  // But the escaped form the scraper emits is unescaped.
  assert.equal(stripMarkdown('post URL\\_DATABASE issues'), 'post URL_DATABASE issues');
});

test('arithmetic and globs are not emphasis', () => {
  assert.equal(stripMarkdown('run 2 * 3 and match foo*bar'), 'run 2 * 3 and match foo*bar');
  assert.equal(stripMarkdown('this is *really* bad'), 'this is really bad');
});

test('scraper escapes are undone', () => {
  // Trustpilot through the scraper: "\[Cameron Ross ... ]\(/users/69d3b590)".
  assert.equal(stripMarkdown('\\[Cameron Ross\\]'), '[Cameron Ross]');
  assert.equal(stripMarkdown('Terms \\& Conditions'), 'Terms & Conditions');
});

test('table scaffolding goes, table words stay', () => {
  const hn = '|[](https://news.ycombinator.com) |**Hacker News** new | past | comments |\n| --- | --- | --- |';
  const out = stripMarkdown(hn);
  assert.ok(!out.includes('---'), 'the separator row carries no words at all');
  assert.ok(out.includes('Hacker News'), out);
});

test('bullets lose the marker and keep the item', () => {
  assert.equal(
    stripMarkdown('* user id: 8039424\n* slug: aballai'),
    'user id: 8039424\nslug: aballai',
  );
});

test('ordinary prose is returned untouched', () => {
  const plain = "Your code lives on someone else's servers when you use Replit. "
    + 'Every file, every API key you type — it costs $5-$10 (maybe more).';
  assert.equal(stripMarkdown(plain), plain);
});

test('empty and absent input are safe', () => {
  assert.equal(stripMarkdown(''), '');
  assert.equal(stripMarkdown(undefined as unknown as string), '');
});

test('collapsed snippets still lose their headings', () => {
  // A search snippet arrives with its newlines already gone, so a page's
  // headings end up mid-string. This is verbatim from a Replit scan.
  assert.equal(
    stripMarkdown('# Replit Status ## Is Replit down? ### Top reported issues View and upvote'),
    'Replit Status Is Replit down? Top reported issues View and upvote',
  );
});

test('but a lone mid-sentence hash is left where it is', () => {
  // Ambiguous, and guessing wrong edits somebody's words.
  assert.equal(stripMarkdown('Replit Community Forum # Replit robs use Bugs'),
    'Replit Community Forum # Replit robs use Bugs');
  assert.equal(stripMarkdown('written in C# and F#'), 'written in C# and F#');
});
