/** What a person might have to hand when they mean "this project".
 *
 *  The field feeding the tracker reader holds whatever the resolver put in it,
 *  and that is not always a URL. `microsoft/markitdown` — the shorthand every
 *  GitHub user writes and the one the model returns — threw inside `new URL()`
 *  and surfaced as "cannot work out an issue tracker", which reads as the
 *  tracker being unfindable rather than the string being a shorthand.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { repoUrlFrom, trackerMention, upstreamFor } from './upstream.ts';
import { mentionId } from './mention-id.ts';

test('the owner/name shorthand is a repository', () => {
  assert.equal(repoUrlFrom('microsoft/markitdown'), 'https://github.com/microsoft/markitdown');
});

test('a tracker URL names the repository it belongs to', () => {
  // Previously parsed as a repository path, producing an API URL of
  // `repos/microsoft/markitdown/issues/issues` — a wrong answer rather than a
  // refusal, which is worse.
  for (const input of [
    'https://github.com/microsoft/markitdown/issues',
    'https://github.com/microsoft/markitdown/issues/1180',
    'https://github.com/microsoft/markitdown/pulls',
    'https://github.com/microsoft/markitdown/tree/main/packages',
    'github.com/microsoft/markitdown',
    'https://github.com/microsoft/markitdown.git',
    'git@github.com:microsoft/markitdown.git',
    'https://github.com/microsoft/markitdown/',
  ]) {
    assert.equal(repoUrlFrom(input), 'https://github.com/microsoft/markitdown', input);
  }
});

test('the GitHub tracker is built from the repository, however it was written', () => {
  const expected = 'https://api.github.com/repos/microsoft/markitdown/issues'
    + '?state=open&sort=created&direction=desc&per_page=50';
  for (const input of [
    'microsoft/markitdown',
    'https://github.com/microsoft/markitdown/issues',
    'git@github.com:microsoft/markitdown.git',
  ]) {
    const upstream = upstreamFor(input, 50);
    assert.equal(upstream?.host, 'github', input);
    assert.equal(upstream?.url, expected, input);
    assert.equal(upstream?.web, 'https://github.com/microsoft/markitdown/issues', input);
  }
});

test('a self-hosted GitLab keeps its own origin', () => {
  // GIMP's tracker lives on gitlab.gnome.org, and self-hosted GitLab is common
  // for exactly the kind of project that has a long-lived public tracker.
  const upstream = upstreamFor('https://gitlab.gnome.org/GNOME/gimp/-/issues', 20);
  assert.equal(upstream?.host, 'gitlab');
  assert.match(upstream!.url, /^https:\/\/gitlab\.gnome\.org\/api\/v4\/projects\/GNOME%2Fgimp\/issues/);
});

test('a Bugzilla reference keeps its query', () => {
  // It carries which product and what counts as open; trimming it would ask a
  // different question.
  const url = 'https://bugs.kde.org/rest/bug?product=krita&status=CONFIRMED';
  const upstream = upstreamFor(url, 10);
  assert.equal(upstream?.host, 'bugzilla');
  assert.match(upstream!.url, /product=krita/);
});

test('things that are not repositories are refused, not guessed at', () => {
  assert.equal(repoUrlFrom(''), null);
  assert.equal(repoUrlFrom('markitdown'), null);
  assert.equal(repoUrlFrom('https://github.com/microsoft'), null);
  assert.equal(upstreamFor('not a repo', 10), null);
});

test('a tracker issue keeps the same id across runs', () => {
  // The whole of a defect's provenance hangs off this. An issue cites mentions
  // by id, so a per-run id means every re-run orphans the evidence of every
  // defect triaged from a filed bug — silently, because the thread is still in
  // the corpus under a new number and nothing errors. It cost 27 of the 68
  // defects on the markitdown scan their source panel.
  const row = {
    title: 'CSV conversion scales quadratically with leading blank lines',
    html_url: 'https://github.com/microsoft/markitdown/issues/2449',
    created_at: '2026-09-10T18:47:29Z',
    body: 'CSV conversion slows down quadratically…',
    user: { login: 'ROTl24' },
    labels: ['bug'],
  };

  const first = trackerMention(row, 'https://github.com/microsoft/markitdown/issues');
  const second = trackerMention({ ...row }, 'https://github.com/microsoft/markitdown/issues');
  assert.equal(first.id, second.id);
  // And the same id every other source would give the same URL, so a tracker
  // report and a search hit on the same thread are one mention, not two.
  assert.equal(first.id, mentionId('https://github.com/microsoft/markitdown/issues/2449'));
  assert.equal(first.complaint, true, 'a filed bug is a complaint by construction');
});

test('a row with no link of its own falls back to the tracker, not to a random id', () => {
  const mention = trackerMention({ title: 'untitled' }, 'https://github.com/microsoft/markitdown/issues');
  assert.equal(mention.url, 'https://github.com/microsoft/markitdown/issues');
  assert.equal(mention.id, mentionId('https://github.com/microsoft/markitdown/issues'));
});
