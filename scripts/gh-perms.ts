import { secret } from '../app/server/secrets.ts';
const token = secret('GITHUB_TOKEN')!;
const H = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'whisperer' };

const probe = async (label: string, url: string, init?: RequestInit) => {
  const r = await fetch(url, { ...init, headers: { ...H, ...(init?.headers ?? {}) } });
  const scopes = r.headers.get('x-oauth-scopes');
  console.log(`${label.padEnd(34)} ${r.status}${scopes !== null ? `  scopes: "${scopes}"` : '  (fine-grained token)'}`);
  return r;
};

await probe('GET /user', 'https://api.github.com/user');
await probe('GET own repo (hangman-test)', 'https://api.github.com/repos/kristopolous/hangman-test');
await probe('GET upstream (crawl4ai)', 'https://api.github.com/repos/unclecode/crawl4ai');
await probe('GET /user/repos', 'https://api.github.com/user/repos?per_page=1');
