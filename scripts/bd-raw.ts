import { usableConnectors } from '../app/server/config.ts';
import { callTool } from '../app/server/mcp.ts';

const c = usableConnectors().find((x) => x.name === 'bright-data')!;
const r = await callTool(c, 'scrape_as_markdown',
  { url: 'https://www.reddit.com/r/Outlook/comments/1w3ifwe/outlook_down_for_you_all/' }, 90_000);
console.log('isError:', r.isError, 'length:', r.text.length);
console.log('--- first 300 ---'); console.log(JSON.stringify(r.text.slice(0, 300)));
console.log('--- markers found ---');
for (const m of r.text.matchAll(/=+UNTRUSTED[^=]*=+/g)) console.log(' ', JSON.stringify(m[0]), 'at', m.index);
console.log('--- last 200 ---'); console.log(JSON.stringify(r.text.slice(-200)));
