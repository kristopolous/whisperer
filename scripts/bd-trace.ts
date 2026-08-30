import { usableConnectors } from '../app/server/config.ts';
import { unwrapUntrusted } from '../app/server/content.ts';
import { callTool } from '../app/server/mcp.ts';

const url = 'https://www.reddit.com/r/Outlook/comments/1w3ifwe/outlook_down_for_you_all/';
const connector = usableConnectors().find((c) => c.name === 'bright-data');
console.log('connector found:', !!connector);
if (!connector) process.exit(1);

try {
  const r = await callTool(connector, 'scrape_as_markdown', { url }, 60_000);
  console.log('isError:', r.isError, 'raw length:', r.text.length);
  const page = unwrapUntrusted(r.text);
  console.log('unwrapped length:', page.length, '| passes >200:', page.length > 200);
  console.log('first 120:', JSON.stringify(page.slice(0, 120)));
} catch (e) {
  console.log('THREW:', e instanceof Error ? e.message : e);
}
