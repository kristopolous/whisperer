const r = await fetch('https://api.github.com/repos/unclecode/crawl4ai',
  { headers: { Accept: 'application/json', 'User-Agent': 'whisperer' } });
const d = await r.json() as Record<string, unknown>;
for (const k of ['name', 'full_name', 'description', 'homepage', 'topics', 'stargazers_count', 'open_issues_count', 'language', 'archived']) {
  console.log(`${k.padEnd(20)} ${JSON.stringify(d[k])?.slice(0, 110)}`);
}
