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
