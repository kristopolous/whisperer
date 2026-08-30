/** A search box for a list, and the matcher behind it.
 *
 *  Every panel in this dashboard is a list of a few hundred rows — mentions,
 *  issues, feed items, accounts — and the only way to find anything in one was
 *  the browser's own find-in-page, which stops at whatever is rendered. A scan
 *  that collects 463 mentions needs a way to ask "what did people say about
 *  crashes" without reading all of them.
 */

/** Case-insensitive, all terms must appear, order irrelevant.
 *
 *  AND rather than OR because narrowing is the point: typing more words should
 *  get you closer to the one row you are after, not bury it under everything
 *  that matched any word. */
export function matches(query: string, ...fields: (string | null | undefined)[]): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = fields.filter(Boolean).join(' ').toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export function Filter({
  value,
  onChange,
  placeholder,
  showing,
  total,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  /** How many rows survive the filter, and how many there are. */
  showing: number;
  total: number;
}) {
  return (
    <div className="filter">
      <input
        className="filter-input"
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
      />
      <span className="filter-count">
        {value.trim() ? `${showing} of ${total}` : `${total}`}
      </span>
      {value.trim() !== '' && (
        <button className="ghost filter-clear" onClick={() => onChange('')} title="Clear">clear</button>
      )}
    </div>
  );
}
