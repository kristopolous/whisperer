import { usableConnectors } from '../app/server/config.ts';
import { listTools } from '../app/server/mcp.ts';

const c = usableConnectors().find((x) => x.name === 'bright-data');
if (!c) { console.log('bright-data not usable'); process.exit(1); }
const tools = await listTools(c, 30_000);
console.log(`${tools.length} tools`);
for (const t of tools) {
  if (/search|serp|engine|google|bing/i.test(t.name)) {
    console.log(`  ${t.name}`);
    console.log(`     ${(t.description ?? '').slice(0, 150)}`);
  }
}
