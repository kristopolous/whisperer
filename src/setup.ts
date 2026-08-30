/**
 * Applies src/registry.ts to the local TrueForge instance, then probes each MCP
 * server so a container that is down or misconfigured shows up here rather than
 * mid-conversation.
 */
import { availableServers } from '../app/server/pipeline.ts';
import { agents } from './agents.ts';
import { client } from './client.ts';
import { mcpServers, skills } from './registry.ts';

for (const manifest of skills) {
  const { data: skill } = await client.settings.skills.createOrUpdate({ manifest });
  const m = skill.manifest;
  console.log(`skill  ${skill.name}  <- ${m.url}${m.path ? '/' + m.path : ''} @ ${m.ref.slice(0, 12)}`);
}

const { data: existingAgents } = await client.agents.list();
const agentIdByName = new Map(existingAgents.map((a) => [a.name, a.id]));

// A saved agent is validated eagerly: TrueForge 422s if it names a connector
// that isn't currently configured (unlike a live session, which only finds out
// when the model tries to call it — see the preload:false note in pipeline.ts).
// src/agents.ts lists what each agent wants; narrow to what this instance has.
const connected = new Set(await availableServers());

for (const { name, manifest } of agents) {
  const wanted = manifest.mcpServers ?? [];
  const attached = wanted.filter((s) => connected.has(s.name));
  const skipped = wanted.filter((s) => !connected.has(s.name)).map((s) => s.name);

  const existingId = agentIdByName.get(name);
  const { data: agent } = existingId
    ? await client.agents.update(existingId, { manifest: { ...manifest, mcpServers: attached } })
    : await client.agents.create({ name, manifest: { ...manifest, mcpServers: attached } });

  const note = attached.length ? `${attached.length} connectors` : 'no connectors — reasons over the prompt';
  console.log(`agent  ${agent.name}  ${existingId ? '(updated)' : '(created)'}  ${note}`);
  if (skipped.length) console.log(`       skipped (not configured): ${skipped.join(', ')}`);
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
