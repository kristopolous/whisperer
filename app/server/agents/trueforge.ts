/** Export the agent definitions as TrueForge saved agents.
 *
 *  This is the re-migration path, and the reason the definitions in this
 *  directory are plain data with no vendor types in them. Whisperer runs its
 *  agents directly — it calls the model endpoint itself and keeps its own trace
 *  of what happened, because a platform that cannot tell you whether a run
 *  succeeded is not worth the dependency. But "we no longer route through it"
 *  should not mean "we can never route through it again", so the definitions
 *  stay exportable and `npm run setup` still pushes all of them.
 *
 *  A second platform is another file next to this one. Nothing above this layer
 *  changes.
 */

import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { usableConnectors } from '../config.ts';
import { strictify } from '../schemas.ts';
import { AGENTS } from './registry.ts';
import { exportedInstructions, type AgentDefinition, type Effort } from './types.ts';

const MODEL = process.env.TRUEFORGE_MODEL ?? 'openai/gpt-5-6-terra';
const BASE_URL = process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790';

/** Not every model takes a reasoning-effort setting, and TrueForge rejects the
 *  whole agent with a 422 when one is sent to a model that does not support it
 *  ("Model X does not support configurable reasoning effort"). Local
 *  llama.cpp-backed models are in that group. Ask the catalog what this model
 *  can actually do rather than assuming, so switching TRUEFORGE_MODEL between a
 *  hosted and a local model does not need a code change.
 *
 *  Probed lazily rather than at import time: this module is imported by the
 *  dashboard's agent list, and importing a file should not dial a service that
 *  may not be running. */
async function modelSupportsEffort(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/api/v1/models`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return false;
    const body = (await response.json()) as {
      data?: { name?: string; properties?: { reasoning_efforts?: string[] } }[];
    };
    const entry = body.data?.find((m) => m.name === MODEL);
    return Boolean(entry?.properties?.reasoning_efforts?.length);
  } catch {
    return false;
  }
}

const effortParams = (supported: boolean, effort: Effort) =>
  (supported ? { reasoningEffort: effort } : {});

/** An agent that does its own retrieval, so it gets the connectors attached. */
const searchAgent = (agent: AgentDefinition, effortOk: boolean): TrueForgeApi.AgentSpec => ({
  // Serial tool calls, not parallel: several of these connectors enforce a
  // hard per-second cap of their own (Brave's server is literally
  // perSecond: 1 in its source), and the model's default is to fire a batch
  // of search calls at once. That batch was arriving as simultaneous
  // requests and 429ing almost everything past the first — one bad request
  // pattern, not a broken backend. Serial calls pace themselves at the
  // latency of each real HTTP round trip, which alone clears every limit
  // these servers document.
  model: { name: MODEL, params: { ...effortParams(effortOk, agent.effort), parallelToolCalls: false } },
  instructions: exportedInstructions(agent),
  mcpServers: agent.connectors.map((name) => ({ name, preload: false, requireApprovalForTools: [] })),
  responseFormat: { type: 'json_schema', jsonSchema: strictify(agent.schema.schema) as never },
  config: { askUserQuestions: { enabled: false } },
});

/** An agent that reasons over a corpus it is handed — no tools, and that has to
 *  be enforced rather than merely implied by leaving mcpServers off.
 *
 *  A llama.cpp-backed endpoint (which is what the local/ollama providers are)
 *  returns `400 Failed to initialize samplers: failed to parse grammar` when a
 *  request carries BOTH a json_schema response_format and a tools array —
 *  either one alone is fine, the combination is not. TrueForge injects its own
 *  built-in tools when dynamicSubAgents or generativeUi are on, and both
 *  default to on, so a "tool-free" reasoning agent was still sending tools and
 *  every buzz/health turn 400d. Turning them off is what actually makes these
 *  agents tool-free on the wire. */
const reasoningAgent = (agent: AgentDefinition, effortOk: boolean): TrueForgeApi.AgentSpec => ({
  model: { name: MODEL, params: { ...effortParams(effortOk, agent.effort) } },
  instructions: exportedInstructions(agent),
  responseFormat: { type: 'json_schema', jsonSchema: strictify(agent.schema.schema) as never },
  config: {
    askUserQuestions: { enabled: false },
    dynamicSubAgents: { enabled: false },
    generativeUi: { enabled: false },
  },
});

/** Every definition, as a TrueForge create-or-update request. */
export async function toTrueForgeAgents(): Promise<TrueForgeApi.CreateAgentRequest[]> {
  const effortOk = await modelSupportsEffort();
  return AGENTS.map((agent) => ({
    name: agent.name,
    manifest: agent.connectors.length
      ? searchAgent(agent, effortOk)
      : reasoningAgent(agent, effortOk),
  }));
}

/** The connector config, as TrueForge MCP server manifests.
 *
 *  Every connector Whisperer uses is a remote streamable-http endpoint, which
 *  is all TrueForge ever recorded about them, so the config file converts
 *  cleanly and stays the one place the list is maintained. Connectors missing a
 *  credential are left out: registering one before it can connect just puts a
 *  dead connector in front of every agent.
 */
export function toTrueForgeMcpServers(): TrueForgeApi.McpServerManifest[] {
  return usableConnectors().map((connector) => ({
    type: 'remote' as const,
    name: connector.name,
    url: connector.url,
    description: connector.description,
    ...(connector.auth?.type === 'bearer'
      ? { auth: { type: 'header' as const, headers: { Authorization: `Bearer ${connector.auth.token}` } } }
      : connector.auth?.type === 'header'
        ? { auth: { type: 'header' as const, headers: connector.auth.headers } }
        : {}),
  }));
}
