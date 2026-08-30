import { usableConnectors } from '../app/server/config.ts';
import { callTool, listTools } from '../app/server/mcp.ts';

const c = usableConnectors().find((x) => x.name === 'bright-data')!;
const schema = (await listTools(c, 30_000)).find((t) => t.name === 'search_engine');
console.log('input schema:', JSON.stringify((schema as Record<string, unknown>).inputSchema ?? {}).slice(0, 300));

const started = Date.now();
const r = await callTool(c, 'search_engine',
  { query: 'site:reddit.com crawl4ai', engine: 'google' }, 90_000);
console.log(`\ncall: ${Math.round((Date.now() - started) / 1000)}s  isError=${r.isError}  ${r.text.length} chars`);
console.log(r.text.slice(0, 700).replace(/\s+/g, ' '));
