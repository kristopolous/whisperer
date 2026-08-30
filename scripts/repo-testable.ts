/** Is a repo's fix verifiable — does it have a test suite we could run? */
const repo = process.argv[2] ?? 'unclecode/crawl4ai';
const get = async (path: string) => {
  const r = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`,
    { headers: { Accept: 'application/json', 'User-Agent': 'whisperer' } });
  return r.ok ? (await r.json() as { name: string }[]) : null;
};

const root = await get('');
const names = (root ?? []).map((f) => f.name);
console.log('root:      ', names.filter((n) => /^tests?$|pytest|tox|noxfile|conftest|pyproject|setup\.py|package\.json|Cargo\.toml/i.test(n)).join(', ') || '(nothing obvious)');
const tests = await get('tests');
console.log('tests/:    ', tests ? `${tests.length} entries — ${tests.slice(0, 6).map((f) => f.name).join(', ')}` : 'no tests directory');
