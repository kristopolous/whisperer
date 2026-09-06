/** Shared subject-name helpers. Both server and web derive a clean human title
 *  from whatever was typed in, so the subject is never just a URL — while the
 *  original input is kept as the site for linking. */

const TLD = /\.(com|co\.uk|co|org|net|io|dev|app|ai|me|us|gov|edu|xyz|site|news|blog|company|social)$/i;
/** Two-part country TLDs that are not the brand: example.co.uk → example. */
const SECOND_LEVEL = /\.(co\.uk|com\.au|co\.nz|co\.in|com\.br|co\.jp|com\.mx|org\.uk|gov\.uk)$/i;

/** Strip protocol + www + trailing slash so a raw URL reads as a bare host,
 *  e.g. https://www.example.co.uk/ → example.co.uk. */
export function hostOf(raw: string): string {
  return raw
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split(/[/?#]/)[0]
    .trim();
}

/** True when the input reads like a URL or bare host (has a dot) rather than a
 *  plain name phrase. */
export function looksLikeHost(raw: string): boolean {
  const value = raw.trim();
  return /^https?:\/\//i.test(value) || /^[\w-]+(\.[\w-]+)+(\.|\/|$)/.test(value);
}

/** Code-hosting sites, where the useful name is in the path rather than the
 *  host. Every repository on GitHub shares one hostname. */
const CODE_HOSTS = /(^|\.)(github\.com|gitlab\.[a-z0-9.-]+|bitbucket\.org|codeberg\.org|git\.sr\.ht|gitea\.[a-z0-9.-]+)$/i;

/** "https://github.com/ggml-org/llama.cpp" → "llama.cpp".
 *
 *  A repository URL names its project in the path, and reducing it to the host
 *  gives "Github" — which is what every repository pasted into the box was
 *  called until the resolver got round to it, and what the run was still called
 *  in the runs rail afterwards. The path is right immediately and for free, so
 *  there is no reason to show a wrong name while waiting on a model.
 *
 *  Returned verbatim, not title-cased: a repository name is written the way its
 *  author wrote it, and "Llama.cpp" is not that. */
export function repoName(raw: string): string | null {
  const value = raw.trim();
  if (!looksLikeHost(value)) return null;
  if (!CODE_HOSTS.test(hostOf(value))) return null;

  const path = value
    .replace(/^https?:\/\//i, '')
    .split(/[?#]/)[0]!
    .split('/')
    .slice(1)
    .filter(Boolean);

  // owner/repo. One segment is a user or organisation page, which names a
  // person rather than a project.
  if (path.length < 2) return null;
  return path[1]!.replace(/\.git$/i, '') || null;
}

/** "https://www.example.co.uk/" → "Example". A plain phrase ("Acme Inc") is
 *  passed through unchanged. */
export function cleanName(raw: string): string {
  const value = raw.trim();
  if (!looksLikeHost(value)) return value;

  const repo = repoName(value);
  if (repo) return repo;

  const host = hostOf(value);
  let cleaned = host;
  if (SECOND_LEVEL.test(host)) cleaned = host.replace(SECOND_LEVEL, '');
  else if (TLD.test(host)) cleaned = host.replace(TLD, '');
  else cleaned = host.split('.')[0];

  return cleaned
    .split(/[-_]/)
    .map((part) => part ? part[0].toUpperCase() + part.slice(1) : part)
    .join(' ');
}

/** A host with a scheme on the front, so it can be given to `new URL`.
 *
 *  The resolver returns whatever the model wrote, and for replit it wrote
 *  `replit.com` where for gimp and bolt it wrote full URLs. The crawl agent
 *  called `new URL('replit.com')`, which throws — so that scan silently fell
 *  back to search and read none of the company's own site, over a missing
 *  eight characters. Empty stays empty: nothing is not a URL. */
export function absoluteUrl(raw: string): string {
  const value = (raw ?? '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (!looksLikeHost(value)) return '';
  return `https://${value.replace(/^\/+/, '')}`;
}

/** The raw input kept as the clickable site, if it looks like a host. */
export function siteOf(raw: string): string {
  const value = raw.trim();
  return looksLikeHost(value) ? value : '';
}

/** The term to actually search for, which is not always what was typed.
 *
 *  People describe a subject rather than name it — "gimp image editor" instead
 *  of "gimp". Every discovery query quotes this term as an exact phrase, and
 *  almost nobody writes "gimp image editor" in a sentence, so a scan for it came
 *  back with two results and every downstream panel was empty. The scan did not
 *  fail; it searched faithfully for a phrase that does not occur.
 *
 *  Once the site has been resolved, the domain is the brand: gimp.org is GIMP
 *  whatever the person typed. So when the subject is a multi-word phrase and a
 *  site is known, the domain wins.
 *
 *  A single typed word is left alone. It is already a term, and second-guessing
 *  it would break the case where someone deliberately searched for a product
 *  whose name differs from its domain.
 */
export function brandToken(company: string, site: string): string {
  const typed = (company ?? '').trim();
  if (!typed) return typed;
  if (typed.split(/\s+/).length === 1) return typed;

  const host = hostOf(site ?? '');
  if (!host) return typed;

  const fromHost = cleanName(host);
  return fromHost.length >= 3 ? fromHost : typed;
}
