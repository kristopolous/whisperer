/** Markdown is a transport format here, not something anybody asked to read.
 *
 *  Most of the corpus arrives through a scraper that renders pages to markdown,
 *  and that markup survived all the way to the screen. Measured across two real
 *  scans: 220 mention excerpts carrying `[text](url)`, 205 carrying `##`
 *  headings, 159 carrying `**bold**`, and the feed no better. What a person
 *  reads on the dashboard is somebody's sentence with the page's plumbing
 *  wrapped around it —
 *
 *    "I got impacted by this known Replit issue - [https://status.replit.com/
 *     incidents/f551e79f](https://status.replit.com/incidents/f551e79f)"
 *
 *  — where the URL appears twice and neither copy is a link.
 *
 *  The rules below are deliberately conservative, because the failure mode of a
 *  markdown stripper on prose that was never markdown is silent corruption of
 *  somebody's words. Two specific restraints:
 *
 *  - **Underscores are left alone entirely**, in both the `_x_` and `__x__`
 *    forms. `_italic_` is real markdown and so is `URL_DATABASE` and
 *    `snake_case`; `__bold__` is real markdown and so is `__init__`. There is
 *    no way to tell them apart in a bug report, and mangling an identifier
 *    inside a defect quote is far worse than leaving an underscore in. `**` is
 *    unambiguous and covers effectively all real emphasis in this corpus, so
 *    nothing is lost. A test asserts `__init__` survives, because the first
 *    version of this function ate it.
 *  - **A single `#` only counts at the start of a line.** `(from #498)` is an
 *    issue reference and it appears in this corpus. Two or more hashes before a
 *    space are treated as a heading anywhere, because snippets arrive with
 *    their newlines collapsed and a page's `##` headings end up mid-sentence.
 *
 *  Nothing here is a filter: no text is dropped, only its markup. A link keeps
 *  whichever of its label or its target actually says something.
 */

/** Backslash escapes the scraper adds so its own output round-trips. */
const UNESCAPE = /\\([\\`*_{}[\]()#+\-.!&>|~])/g;

const isUrl = (text: string) => /^(?:https?:\/\/|www\.)/i.test(text.trim());

export function stripMarkdown(input: string): string {
  if (!input) return '';
  let out = input;

  // Fenced code: keep the code, drop the fence and its language tag.
  out = out.replace(/```[a-z0-9+#-]*\n?/gi, ' ');

  // Images first, so their `!` does not leave a stray mark once the link inside
  // them is unwrapped. An alt text is a description of a picture nobody can
  // see, which is worth less than the space it takes.
  out = out.replace(/!\[[^\]]*\]\([^)\s]*(?:\s+"[^"]*")?\)/g, ' ');

  // Links: keep the label, unless the label is the URL again (the scraper's
  // commonest shape) or is empty, in which case keep the target once.
  out = out.replace(
    /\[([^\]]*)\]\(\s*<?([^)\s]*)>?(?:\s+"[^"]*")?\s*\)/g,
    (_whole, label: string, href: string) => {
      const text = label.trim();
      if (!text) return isUrl(href) ? href : '';
      if (isUrl(text) && isUrl(href)) return text;
      return text;
    },
  );

  // Reference-style links, whose definitions sit at the bottom of the document.
  out = out.replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, ' ');
  out = out.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');

  // Headings, block quotes and list markers: the marker goes, the line stays.
  // Dropping the line would delete content, which is not this function's job.
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  // Snippets arrive with their newlines already collapsed, so a page's headings
  // end up mid-line: "# Replit Status ## Is Replit down? ### Top reported
  // issues" is one string. A run of two or more hashes followed by a space is
  // safe to treat as a heading wherever it appears — `#498` is a single hash
  // with no space, and `C#` is preceded by a word character.
  out = out.replace(/(^|\s)#{2,}\s+/g, '$1');
  out = out.replace(/^\s{0,3}>\s?/gm, '');
  out = out.replace(/^\s{0,3}[-*+]\s+/gm, '');
  out = out.replace(/^\s{0,3}\d+[.)]\s+/gm, '');

  // Horizontal rules and table scaffolding. A separator row carries no words at
  // all, so it is the one thing here that is removed outright.
  out = out.replace(/^\s{0,3}(?:[-*_]\s?){3,}$/gm, ' ');
  out = out.replace(/^\s*\|?(?:\s*:?-{2,}:?\s*\|)+\s*:?-*:?\s*\|?\s*$/gm, ' ');
  out = out.replace(/^\s*\|/gm, ' ').replace(/\|\s*$/gm, ' ');

  // Emphasis. `**` and `__` are unambiguous; a lone `*` is only treated as
  // emphasis when it is not touching a word character on the outside, so
  // `2 * 3` and `foo*bar` survive.
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1$2');
  out = out.replace(/~~([^~]+)~~/g, '$1');

  // Inline code: the backticks are punctuation the reader did not type.
  out = out.replace(/`([^`\n]+)`/g, '$1');

  return out.replace(UNESCAPE, '$1').replace(/[ \t]{2,}/g, ' ').trim();
}
