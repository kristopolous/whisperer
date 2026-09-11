/** Every agent Whisperer has, in one list.
 *
 *  This is the answer to "what agents do we have and what are they for" — a
 *  question that previously could only be answered by asking the platform,
 *  which is exactly the opacity worth getting rid of. The list is ordinary
 *  data: the dashboard renders it, the exporters walk it, and adding an agent
 *  means adding a file here rather than editing a provisioning script.
 */

import { abuseAgent } from './abuse.ts';
import { buzzAgent } from './buzz.ts';
import { complaintsAgent } from './complaints.ts';
import { subjectMatchAgent } from './subject-match.ts';
import { feedQualityAgent } from './feed-quality.ts';
import { crawlAgent } from './crawl.ts';
import { diagnoseAgent } from './diagnose.ts';
import { discoveryAgent } from './discovery.ts';
import { feedAgent } from './feed.ts';
import { fileTicketAgent } from './file-ticket.ts';
import { fixAgent } from './fix.ts';
import { footprintAgent } from './footprint.ts';
import { healthAgent } from './health.ts';
import { migrationsAgent } from './migrations.ts';
import { reproduceAgent } from './reproduce.ts';
import { rescueAgent } from './rescue.ts';
import { resolveAgent } from './resolve.ts';
import { respondAgent } from './respond-to-user.ts';
import { siteAgent } from './site.ts';
import { topicsAgent } from './topics.ts';
import { verdictAgent } from './verdict.ts';
import type { AgentDefinition } from './types.ts';

/** Scan order first, then the agents a person fires by hand — the order the
 *  agent list should read in. */
export const AGENTS: AgentDefinition[] = [
  resolveAgent,
  // Fires only when a deterministic step fails, so its run history is also the
  // record of which parsers are not covering the shapes the world produces.
  rescueAgent,
  crawlAgent,
  footprintAgent,
  discoveryAgent,
  complaintsAgent,
  subjectMatchAgent,
  feedQualityAgent,
  feedAgent,
  buzzAgent,
  verdictAgent,
  topicsAgent,
  migrationsAgent,
  healthAgent,
  abuseAgent,
  fileTicketAgent,
  diagnoseAgent,
  // Before the fix, always: a test written beside its own patch proves less
  // than one written first.
  reproduceAgent,
  fixAgent,
  respondAgent,
  siteAgent,
];

const index = new Map(AGENTS.map((agent) => [agent.name, agent]));

export const agentByName = (name: string): AgentDefinition | undefined => index.get(name);

/** The agents a scan actually fires today, as opposed to the ones kept saved
 *  for manual use. The dashboard needs the distinction so an agent that has
 *  never run doesn't read as one that failed. */
export const pipelineAgents = () => AGENTS.filter((agent) => agent.inPipeline);

/** Every MCP connector some agent depends on. The connector config is allowed
 *  to hold more than this; nothing is allowed to hold less. */
export const requiredConnectors = (): string[] =>
  [...new Set(AGENTS.flatMap((agent) => agent.connectors))].sort();
