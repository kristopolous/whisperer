/** Which URLs belong to the subject itself.
 *
 *  Discovery drops the vendor's own pages: a company's blog, docs and status
 *  page are not third-party discussion, and letting them in fills the corpus
 *  with the subject talking about itself. That test was `url.includes(host)`,
 *  which is right for `replit.com` and catastrophic for a project that lives on
 *  a host it shares with everybody else.
 *
 *  `github.com/microsoft/markitdown` has a hostname of `github.com`. Matching on
 *  the hostname makes every issue, every discussion, every pull request and
 *  every unrelated project on GitHub "the vendor's own site" — which for an
 *  open-source project deletes the entire corpus, including the issue tracker
 *  that is the best evidence anywhere about what is broken. The one place
 *  guaranteed to hold real defects is the one place that filter removes.
 *
 *  So a subject hosted under a path on a shared host owns that path, not the
 *  host. `github.com/microsoft/markitdown/issues/12` is theirs;
 *  `github.com/someone-else/thing` is not, and neither is a comment on their
 *  own tracker by somebody else — but that distinction is the tracker reader's
 *  job, not this one's.
 */

/** Hosts where a path segment, not the hostname, identifies the owner.
 *
 *  Only hosts that are genuinely multi-tenant in this way. A subject on a host
 *  not listed here owns the whole hostname, which is the ordinary case. */
const SHARED_HOSTS: Record<string, number> = {
  'github.com': 2,
  'gitlab.com': 2,
  'bitbucket.org': 2,
  'codeberg.org': 2,
  'sourceforge.net': 2,
  'huggingface.co': 2,
  'gitee.com': 2,
  'npmjs.com': 2,
  'pypi.org': 2,
  'crates.io': 2,
  'rubygems.org': 2,
  'packagist.org': 2,
  'hub.docker.com': 2,
  'marketplace.visualstudio.com': 1,
  'apps.apple.com': 2,
  'play.google.com': 1,
  'addons.mozilla.org': 2,
  'chromewebstore.google.com': 2,
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};

const segments = (url: string): string[] => {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).map((part) => part.toLowerCase());
  } catch {
    return [];
  }
};

export interface OwnSite {
  /** True when this URL is the subject's own page rather than somebody
   *  discussing it. */
  owns: (url: string) => boolean;
  /** What is actually being matched, for the run log — "github.com/microsoft/
   *  markitdown" rather than a bare hostname, so a reader can see that the
   *  whole host was not excluded. */
  label: string;
}

export function ownSite(site: string): OwnSite {
  const host = hostOf(site);
  if (!host) return { owns: () => false, label: '' };

  const depth = SHARED_HOSTS[host];
  if (!depth) {
    // The ordinary case: the subject owns its hostname and every subdomain of
    // it. Matched on the hostname rather than on the whole URL string, because
    // `includes(host)` also matches `notreplit.com` and, worse, any URL that
    // merely mentions the domain in a query parameter.
    return {
      owns: (url) => {
        const other = hostOf(url);
        return other === host || other.endsWith(`.${host}`);
      },
      label: host,
    };
  }

  const own = segments(site).slice(0, depth);
  if (own.length === 0) {
    // A bare shared host with no path names no owner at all — excluding all of
    // GitHub because somebody typed "github.com" would be worse than excluding
    // nothing.
    return { owns: () => false, label: '' };
  }

  const prefix = own.join('/');
  return {
    owns: (url) => {
      if (hostOf(url) !== host) return false;
      return segments(url).slice(0, depth).join('/') === prefix;
    },
    label: `${host}/${prefix}`,
  };
}
