import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import {
  ABUSE_INSTRUCTIONS, ABUSE_SERVERS, BUZZ_INSTRUCTIONS, DISCOVERY_INSTRUCTIONS, DISCOVERY_SERVERS,
  FEED_INSTRUCTIONS, FEED_SERVERS, FOOTPRINT_INSTRUCTIONS, HEALTH_INSTRUCTIONS, PRESENCE_SERVERS,
} from '../app/server/pipeline.ts';
import {
  abuseSchema, buzzSchema, feedSchema, healthSchema, mentionsSchema, profilesSchema, replySchema,
  siteSchema, strictify, ticketSchema,
} from '../app/server/schemas.ts';
import { FILE_TICKET_INSTRUCTIONS } from '../app/server/agents/file-ticket.ts';
import { RESPOND_INSTRUCTIONS } from '../app/server/agents/respond-to-user.ts';

/**
 * Every Whisperer pipeline stage, also saved as a named TrueForge agent — so
 * each one is independently fireable with `sessions.create({ agent: { name } })`
 * from the TrueForge chat UI, a script, or another agent, not just from inside
 * Whisperer's own BFF. Same instructions and schema the pipeline runs, imported
 * rather than copied, so the two can't drift apart.
 *
 * A saved agent has no template parameters — TrueForge doesn't have those. The
 * "parameter" is whatever the caller sends as the first `user.message`; each
 * agent's instructions say what shape that message should take.
 */

const MODEL = process.env.TRUEFORGE_MODEL ?? 'openai/gpt-5-6-terra';

/** Not every model takes a reasoning-effort setting, and TrueForge rejects the
 *  whole agent with a 422 when one is sent to a model that does not support it
 *  ("Model X does not support configurable reasoning effort"). Local
 *  llama.cpp-backed models are in that group. Ask the catalog what this model
 *  can actually do rather than assuming, so switching TRUEFORGE_MODEL between a
 *  hosted and a local model does not need a code change. */
const MODEL_SUPPORTS_EFFORT = await (async () => {
  const base = process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790';
  try {
    const response = await fetch(`${base}/api/v1/models`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return false;
    const body = (await response.json()) as {
      data?: { name?: string; properties?: { reasoning_efforts?: string[] } }[];
    };
    const entry = body.data?.find((m) => m.name === MODEL);
    return Boolean(entry?.properties?.reasoning_efforts?.length);
  } catch {
    return false;
  }
})();

/** Reasoning effort, but only when the configured model accepts one. */
const effortParams = (effort: 'low' | 'medium' | 'high') =>
  (MODEL_SUPPORTS_EFFORT ? { reasoningEffort: effort } : {});

const searchAgent = (
  servers: string[],
  instructions: string,
  schema: unknown,
  effort: 'low' | 'medium' | 'high',
): TrueForgeApi.AgentSpec => ({
  // Serial tool calls, not parallel: several of these connectors enforce a
  // hard per-second cap of their own (Brave's server is literally
  // perSecond: 1 in its source), and the model's default is to fire a batch
  // of search calls at once. That batch was arriving as simultaneous
  // requests and 429ing almost everything past the first — one bad request
  // pattern, not a broken backend. Serial calls pace themselves at the
  // latency of each real HTTP round trip, which alone clears every limit
  // these servers document.
  model: { name: MODEL, params: { ...effortParams(effort), parallelToolCalls: false } },
  instructions,
  mcpServers: servers.map((name) => ({ name, preload: false, requireApprovalForTools: [] })),
  responseFormat: { type: 'json_schema', jsonSchema: strictify(schema) as never },
  config: { askUserQuestions: { enabled: false } },
});

/** Buzz and health reason over a corpus handed to them in the prompt — no
 *  tools, so no mcpServers on these two. */
const reasoningAgent = (
  instructions: string,
  schema: unknown,
  effort: 'low' | 'medium' | 'high',
): TrueForgeApi.AgentSpec => ({
  model: { name: MODEL, params: { ...effortParams(effort) } },
  instructions,
  responseFormat: { type: 'json_schema', jsonSchema: strictify(schema) as never },
  // No tools at all, and that has to be enforced rather than merely implied by
  // leaving mcpServers off.
  //
  // A llama.cpp-backed endpoint (which is what the local/ollama providers are)
  // returns `400 Failed to initialize samplers: failed to parse grammar` when a
  // request carries BOTH a json_schema response_format and a tools array —
  // either one alone is fine, the combination is not. TrueForge injects its own
  // built-in tools when dynamicSubAgents or generativeUi are on, and both
  // default to on, so a "tool-free" reasoning agent was still sending tools and
  // every buzz/health turn 400d. Turning them off is what actually makes these
  // two agents tool-free on the wire.
  config: {
    askUserQuestions: { enabled: false },
    dynamicSubAgents: { enabled: false },
    generativeUi: { enabled: false },
  },
});

const CALLED_WITH_A_TARGET =
  '\n\nHow you are invoked: the first message names the company and, when known, its site — e.g. `"Supabase" (https://supabase.com)`. Treat that as the whole brief; do not ask a follow-up question, the caller is not watching for one.';

const CALLED_WITH_A_CORPUS =
  '\n\nHow you are invoked: the first message names the product, then a JSON array of items to work through, each with at least a url and some text. Process every item in the array; do not sample.';

export const agents: TrueForgeApi.CreateAgentRequest[] = [
  {
    name: 'whisperer-site',
    manifest: searchAgent(['bright-data', 'brave'], 'You find official websites. Answer with the homepage URL only.' + CALLED_WITH_A_TARGET, siteSchema, 'low'),
  },
  {
    name: 'whisperer-footprint',
    manifest: searchAgent(PRESENCE_SERVERS, FOOTPRINT_INSTRUCTIONS + CALLED_WITH_A_TARGET, profilesSchema, 'high'),
  },
  {
    name: 'whisperer-discovery',
    manifest: searchAgent(DISCOVERY_SERVERS, DISCOVERY_INSTRUCTIONS + CALLED_WITH_A_TARGET, mentionsSchema, 'high'),
  },
  {
    name: 'whisperer-feed',
    manifest: searchAgent(FEED_SERVERS, FEED_INSTRUCTIONS + CALLED_WITH_A_TARGET, feedSchema, 'high'),
  },
  {
    name: 'whisperer-buzz',
    manifest: reasoningAgent(BUZZ_INSTRUCTIONS + CALLED_WITH_A_CORPUS, buzzSchema, 'low'),
  },
  {
    name: 'whisperer-health',
    manifest: reasoningAgent(HEALTH_INSTRUCTIONS + CALLED_WITH_A_CORPUS, healthSchema, 'medium'),
  },
  // The two loop agents. Both are reasoning agents — they work over material
  // already gathered, and neither should be able to reach for a tool: a ticket
  // invented from a web search rather than from what the reporters wrote is
  // exactly the failure these are meant to avoid.
  //
  // They are registered here as well as being callable directly so that they
  // are visible and fireable from the TrueForge UI like every other stage. The
  // instructions come from the modules that implement them rather than being
  // copied, so the saved agent and the running code cannot drift.
  {
    name: 'whisperer-file-ticket',
    manifest: reasoningAgent(
      FILE_TICKET_INSTRUCTIONS
      + '\n\nHow you are invoked: the first message names the product, gives the triaged issue as JSON, and '
      + 'then gives what the reporters actually wrote. Write the ticket from those words.',
      ticketSchema,
      'medium',
    ),
  },
  {
    name: 'whisperer-respond',
    manifest: reasoningAgent(
      RESPOND_INSTRUCTIONS
      + '\n\nHow you are invoked: the first message names the product and venue, gives the triaged issue, quotes '
      + 'what the reporter wrote, and says which reply to write — the acknowledgement (nothing is fixed yet) or '
      + 'the follow-up (the fix shipped, ask them to check).',
      replySchema,
      'medium',
    ),
  },
  {
    name: 'whisperer-abuse',
    manifest: searchAgent(ABUSE_SERVERS, ABUSE_INSTRUCTIONS + CALLED_WITH_A_TARGET, abuseSchema, 'high'),
  },
];
