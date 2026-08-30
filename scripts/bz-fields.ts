const r = await fetch('https://bugs.kde.org/rest/bug?product=krita&resolution=---&order=creation_time%20DESC&limit=6',
  { headers: { Accept: 'application/json', 'User-Agent': 'whisperer' } });
const d = await r.json() as { bugs?: Record<string, unknown>[] };
for (const b of d.bugs ?? []) {
  console.log(`${String(b.creation_time ?? '').slice(0, 10)}  sev=${b.severity}  comp=${b.component}  kw=${JSON.stringify(b.keywords)}`);
  console.log(`   ${String(b.summary).slice(0, 66)}`);
}
