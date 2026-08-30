for (const [label, url] of [
  ['Mozilla', 'https://bugzilla.mozilla.org/rest/bug?product=Firefox&resolution=---&limit=3&order=creation_time%20DESC'],
  ['GNOME (legacy)', 'https://bugzilla.gnome.org/rest/bug?product=GIMP&resolution=---&limit=3'],
  ['KDE', 'https://bugs.kde.org/rest/bug?product=krita&resolution=---&limit=3&order=creation_time%20DESC'],
] as [string, string][]) {
  const t = Date.now();
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'whisperer' }, signal: AbortSignal.timeout(25_000) });
    const text = await r.text();
    let n = 0, first = '', keys = '';
    try {
      const d = JSON.parse(text) as { bugs?: Record<string, unknown>[] };
      n = d.bugs?.length ?? 0;
      first = String(d.bugs?.[0]?.summary ?? '');
      keys = Object.keys(d.bugs?.[0] ?? {}).slice(0, 10).join(',');
    } catch { first = text.slice(0, 80); }
    console.log(`${label.padEnd(16)} HTTP ${r.status} ${Math.round((Date.now()-t)/1000)}s  ${n} bugs  ${first.slice(0, 54)}`);
    if (keys) console.log(`                 fields: ${keys}`);
  } catch (e) { console.log(`${label.padEnd(16)} failed — ${e instanceof Error ? e.message : e}`); }
}
