import { upstreamFor } from '../app/server/upstream.ts';
const u = upstreamFor('https://bugs.kde.org/rest/bug?product=krita', 6)!;
console.log('url:', u.url);
const d = await fetch(u.url, { headers: { Accept: 'application/json', 'User-Agent': 'whisperer' } }).then(r => r.json()) as { bugs?: Record<string, unknown>[] };
for (const b of (d.bugs ?? []).slice(0, 6)) {
  console.log(`  ${String(b.creation_time ?? '').slice(0, 10)}  sev=${b.severity}  ${String(b.summary).slice(0, 54)}`);
}
