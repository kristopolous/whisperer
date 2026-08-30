/** Can we read a project's own issue tracker straight off its API? */
const probes: [string, string][] = [
  ['GitLab (GIMP)', 'https://gitlab.gnome.org/api/v4/projects/GNOME%2Fgimp/issues?state=opened&per_page=3&order_by=created_at'],
  ['GitHub (replit repo)', 'https://api.github.com/repos/replit/replit-py/issues?state=open&per_page=3'],
];

for (const [label, url] of probes) {
  const started = Date.now();
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'whisperer' }, signal: AbortSignal.timeout(20_000) });
    const text = await r.text();
    let n = 0, first = '';
    try {
      const rows = JSON.parse(text) as { title?: string }[];
      n = Array.isArray(rows) ? rows.length : 0;
      first = rows[0]?.title ?? '';
    } catch { /* not json */ }
    console.log(`${label.padEnd(22)} HTTP ${r.status}  ${Math.round((Date.now() - started) / 1000)}s  ${n} issues  ${first.slice(0, 60)}`);
  } catch (e) {
    console.log(`${label.padEnd(22)} failed — ${e instanceof Error ? e.message : e}`);
  }
}
