/** Which URLs are the subject's own.
 *
 *  The case that matters is an open-source project on a shared host. Matching
 *  on the hostname makes every issue, discussion and pull request on GitHub
 *  "the vendor's own site" — which deletes the entire corpus for such a
 *  project, including the issue tracker, which is the best evidence anywhere
 *  about what is broken.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { ownSite } from './own-site.ts';

test('a project on GitHub owns its path, not the whole of GitHub', () => {
  const own = ownSite('https://github.com/microsoft/markitdown');
  assert.equal(own.label, 'github.com/microsoft/markitdown');

  // Its own pages: excluded, because the vendor talking about itself is not
  // third-party discussion.
  assert.ok(own.owns('https://github.com/microsoft/markitdown'));
  assert.ok(own.owns('https://github.com/microsoft/markitdown/blob/main/README.md'));

  // Its issue tracker is on that path too — the tracker reader takes those in
  // deliberately, and this filter is not what should be letting them through.
  assert.ok(own.owns('https://github.com/microsoft/markitdown/issues/1180'));

  // Everything else on GitHub is somebody else's, and must survive.
  assert.equal(own.owns('https://github.com/openai/whisper/issues/9'), false);
  assert.equal(own.owns('https://github.com/microsoft/vscode'), false);
  assert.equal(own.owns('https://github.com/orgs/microsoft/discussions'), false);
});

test('an ordinary company owns its hostname and subdomains', () => {
  const own = ownSite('https://replit.com/');
  assert.equal(own.label, 'replit.com');
  assert.ok(own.owns('https://replit.com/pricing'));
  assert.ok(own.owns('https://blog.replit.com/anything'));
  assert.ok(own.owns('https://status.replit.com/'));
  assert.equal(own.owns('https://reddit.com/r/replit'), false);
});

test('a lookalike domain is not the subject', () => {
  // The old test was `url.includes(host)`, which matched this and, worse, any
  // URL merely carrying the domain in a query parameter.
  const own = ownSite('https://replit.com/');
  assert.equal(own.owns('https://notreplit.com/'), false);
  assert.equal(own.owns('https://example.com/?ref=replit.com'), false);
});

test('a bare shared host names no owner', () => {
  // Excluding all of GitHub because somebody typed "github.com" would be worse
  // than excluding nothing.
  const own = ownSite('https://github.com');
  assert.equal(own.label, '');
  assert.equal(own.owns('https://github.com/anyone/anything'), false);
});

test('package registries and app stores work the same way', () => {
  assert.ok(ownSite('https://pypi.org/project/markitdown/').owns('https://pypi.org/project/markitdown/'));
  assert.equal(ownSite('https://pypi.org/project/markitdown/').owns('https://pypi.org/project/requests/'), false);
  assert.ok(ownSite('https://apps.apple.com/us/app/replit/id1614022293')
    .owns('https://apps.apple.com/us/app/replit/id1614022293?platform=iphone'));
});

test('an unparseable site owns nothing', () => {
  assert.equal(ownSite('').owns('https://anything.example'), false);
  assert.equal(ownSite('not a url').label, '');
});
