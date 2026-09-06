/** What an agent *is*, expressed independently of whatever runs it.
 *
 *  Whisperer's agents were originally only expressible as TrueForge manifests:
 *  the instructions, the schema and the connector list existed as arguments to
 *  a `CreateAgentRequest`, and the pipeline held a second copy of the same
 *  strings. That made the platform the source of truth for the part of this
 *  product that is actually ours — the prompts — and it made "which agents do
 *  we have, and did they work" a question only the platform could answer.
 *
 *  So the definition lives here instead, as plain data with no vendor types in
 *  it, and the platforms become exporters:
 *
 *    definition (this directory)
 *      ├── run it directly           → runtime.ts + model.ts
 *      └── save it to a platform     → trueforge.ts
 *
 *  Nothing about this shape is TrueForge-specific, which is the point: adding
 *  a second exporter is a file, and re-migrating onto TrueForge is
 *  `npm run setup`, not a rewrite.
 */

import type { Stage } from '../../shared/types.ts';

/** How hard the model should think, for the models that accept the setting. */
export type Effort = 'low' | 'medium' | 'high';

/** Where an agent is fired from, which is also how the dashboard groups it. */
export type Surface =
  /** Part of a scan — fires automatically, in stage order. */
  | 'stage'
  /** The resolution loop — fires when a person acts on an issue. */
  | 'loop'
  /** Fireable on its own; not part of a scan. */
  | 'utility';

export interface AgentDefinition {
  /** Stable identity, and the saved name on any platform we export to. */
  name: string;
  /** Short label for the agent list. */
  title: string;
  /** One line: what this agent is for. Shown in the agent list and exported as
   *  the platform's description. */
  description: string;
  surface: Surface;
  /** The scan stage this belongs to, for stage agents. */
  stage?: Stage;
  /** The standing instructions — the system prompt. The real asset here. */
  instructions: string;
  /** Appended to the instructions on export to a platform where the only input
   *  is a free-text first message, telling the agent what that message holds.
   *  Not used when we run the agent ourselves, because then we build the
   *  prompt and already know its shape. */
  invocation: string;
  /** The JSON Schema the output is held to, as `{ name, schema }`. */
  schema: { name: string; schema: unknown };
  /** MCP connectors this agent may reach, in preference order. Empty means
   *  tool-free *by contract*, not by omission: several of these agents reason
   *  over a corpus they are handed and must not be able to go looking for more,
   *  because an invented citation is worse than a missing one. */
  connectors: string[];
  /** Which model answers for this agent.
   *
   *  Defaults to `general`. Only the agents that read and write source ask for
   *  `coding` — a mid-sized general model scores sentiment perfectly well and
   *  is noticeably worse at locating a defect in unfamiliar code, so pinning
   *  both to one endpoint means paying for the wrong thing in one direction or
   *  the other. */
  role?: 'general' | 'coding';
  effort: Effort;
  /** True when the agent's instructions tell it to go and use tools.
   *
   *  Nothing in this app can honour that. `runAgent` has no tool loop by
   *  design, and the local runtime cannot be given one — llama.cpp will not
   *  compile a json_schema response format and a tools array into the same
   *  grammar, so a request carrying both is rejected outright. An agent told to
   *  "run the search connectors attached to you" therefore answers from memory,
   *  and an agent answering from memory about what people said online invents
   *  URLs, dates and quotes.
   *
   *  So this is a warning label, not a capability. It sits on the definition
   *  rather than being inferred from the prose, because guessing it from the
   *  instructions would be exactly the kind of invisible behaviour this
   *  registry exists to get rid of. */
  needsTools?: boolean;
  /** False when the live pipeline no longer calls this agent, but it is kept
   *  because it is still worth having as a saved, manually fireable agent.
   *  The agent list shows these separately so "never ran" doesn't read as
   *  "broken". */
  inPipeline: boolean;
}

/** Instructions as a platform should save them: standing instructions plus the
 *  note about what the first message will contain. */
export const exportedInstructions = (agent: AgentDefinition): string =>
  agent.instructions + agent.invocation;
