import { secret } from '../app/server/secrets.ts';
const token = secret('GITHUB_TOKEN');
console.log('token present:', Boolean(token), token ? `(starts ${token.slice(0, 4)})` : '');
if (!token) process.exit(0);
const r = await fetch('https://api.github.com/user', {
  headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'whisperer' },
});
const body = await r.text();
console.log('GET /user ->', r.status);
if (r.ok) {
  const u = JSON.parse(body) as { login: string };
  console.log('authenticated as:', u.login);
  console.log('scopes:', r.headers.get('x-oauth-scopes') ?? '(fine-grained token)');
} else {
  console.log(body.slice(0, 160));
}
