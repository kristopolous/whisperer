/** Turning fragments of HTML into the text a person should read.
 *
 *  Search APIs return escaped markup, not plain text: Brave sends titles and
 *  descriptions with `<strong>` highlighting and every apostrophe as `&#x27;`.
 *  Scraped pages arrive as whole documents. Both end up rendered in the
 *  dashboard and fed to a model as "what somebody said", so both have to be
 *  decoded — and they were being handled in two different ad-hoc ways, one of
 *  which decoded six named entities and the other of which decoded none.
 *
 *  The visible symptom was quotes reading as `it&#x27;s actually a strong
 *  release`. The invisible one is worse: that text is also the corpus the buzz
 *  and triage agents reason over, so entity noise was going into every prompt.
 */

/** The handful of named entities that actually appear in prose. A full table is
 *  thousands of entries and none of the rest survive a search snippet. */
const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  bull: '•',
  deg: '°',
  eacute: 'é',
  egrave: 'è',
  uuml: 'ü',
  ouml: 'ö',
  auml: 'ä',
  szlig: 'ß',
  ccedil: 'ç',
  ntilde: 'ñ',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  pound: '£',
  laquo: '«',
  raquo: '»',
};

/** `&#x27;` / `&#39;` / `&amp;` → the characters they stand for.
 *
 *  `&amp;` is resolved last, and only in a single pass, so a legitimately
 *  double-escaped `&amp;#x27;` becomes `&#x27;` rather than being unwrapped all
 *  the way to an apostrophe. One pass is what the source actually encoded. */
export function decodeEntities(input: string): string {
  if (!input || !input.includes('&')) return input;

  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]{1,31});/gi, (whole, body: string) => {
    const token = body.toLowerCase();

    if (token.startsWith('#x') || token.startsWith('#')) {
      const code = token.startsWith('#x')
        ? Number.parseInt(token.slice(2), 16)
        : Number.parseInt(token.slice(1), 10);
      // Surrogates and out-of-range values throw; a malformed entity should be
      // left as written rather than taking down the line that contains it.
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }

    return NAMED[token] ?? whole;
  });
}

/** Remove tags, keeping their text. Search results carry `<strong>` around the
 *  matched words; scraped pages carry everything. */
export const stripTags = (input: string): string => input.replace(/<[^>]+>/g, ' ');

/** The whole treatment: tags out, entities decoded, whitespace collapsed. */
export function cleanText(input: string): string {
  if (!input) return '';
  return decodeEntities(stripTags(input)).replace(/\s+/g, ' ').trim();
}
