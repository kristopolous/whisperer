import { client } from './pipeline.ts';
import { mcpServers } from '../../src/registry.ts';

/** Health of a single MCP connector as TrueForge sees it. */
export interface ConnectorStatus {
  name: string;
  status: 'ok' | 'needs-auth' | 'down';
  authStatus?: string;
  tools: number;
  error?: string;
}

async function probe(name: string): Promise<ConnectorStatus> {
  let authStatus: string | undefined;
  try {
    const { data } = await client.settings.mcpServers.get(name);
    authStatus = data?.authStatus?.status;
  } catch {
    // fall through to the dial below for the real diagnosis
  }

  // listTools actually dials the server, so it doubles as a health check.
  try {
    const { data: tools } = await client.mcpServers.listTools(name);
    return {
      name,
      authStatus,
      tools: tools.length,
      status: authStatus === 'auth_required' ? 'needs-auth' : 'ok',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name, authStatus, tools: 0, status: 'down', error: message };
  }
}

/** Re-apply the connector manifests (idempotent, like `npm run setup`), then
 *  probe every registered server so a dead or misconfigured connector shows up
 *  here instead of mid-run. A 401 from an upstream is diagnosed and surfaced
 *  as a row the user can act on. */
export async function reconnectConnectors(): Promise<ConnectorStatus[]> {
  const names: string[] = [];
  for (const manifest of mcpServers) {
    try {
      const { data: server } = await client.settings.mcpServers.createOrUpdate({ manifest });
      names.push(server.name);
    } catch {
      names.push(manifest.name);
    }
  }
  return Promise.all(names.map(probe));
}

/** Just probe whatever is currently on the Settings → MCP Servers list (the
 *  config-level endpoint, GET /api/v1/settings/mcp-servers), without re-applying
 *  anything. */
export async function checkConnectors(): Promise<ConnectorStatus[]> {
  const { data } = await client.settings.mcpServers.list();
  const names = data.map((s) => s.name);
  return Promise.all(names.map(probe));
}
