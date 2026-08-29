/**
 * Applies src/registry.ts to the local TrueForge instance, then probes each MCP
 * server so a container that is down or misconfigured shows up here rather than
 * mid-conversation.
 */
import { client } from './client.ts';
import { mcpServers, skills } from './registry.ts';

for (const manifest of skills) {
  const { data: skill } = await client.settings.skills.createOrUpdate({ manifest });
  const m = skill.manifest;
  console.log(`skill  ${skill.name}  <- ${m.url}${m.path ? '/' + m.path : ''} @ ${m.ref.slice(0, 12)}`);
}

for (const manifest of mcpServers) {
  const { data: server } = await client.settings.mcpServers.createOrUpdate({ manifest });
  console.log(`mcp    ${server.name}  <- ${manifest.url}  auth=${server.authStatus.status}`);

  // listTools actually dials the server, so it doubles as a health check.
  try {
    const { data: tools } = await client.mcpServers.listTools(server.name);
    const names = tools.map((t) => String(t.name));
    console.log(`       ${names.length} tools: ${names.slice(0, 8).join(', ')}${names.length > 8 ? ', …' : ''}`);
  } catch (err) {
    console.log(`       unreachable — is it running? (${err instanceof Error ? err.message : err})`);
  }
}
