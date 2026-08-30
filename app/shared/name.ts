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

/** "https://www.example.co.uk/" → "Example". A plain phrase ("Acme Inc") is
 *  passed through unchanged. */
export function cleanName(raw: string): string {
  const value = raw.trim();
  if (!looksLikeHost(value)) return value;

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
