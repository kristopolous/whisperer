import { fetchContent } from '../app/server/content.ts';

for (const url of [
  'https://www.trustpilot.com/review/replit.com',
  'https://www.trustpilot.com/review/www.gimp.org',
  'https://www.trustpilot.com/review/notion.so',
]) {
  const got = await fetchContent(url, '(none)', 20_000);
  console.log(`\n=== ${url}  (${got.full ? 'full' : 'blocked'}, ${got.text.length} chars)`);
  console.log(got.text.replace(/\s+/g, ' ').slice(0, 320));
}
