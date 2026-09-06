/** Resolve a company name to its official homepage.
 *
 *  Not in the live pipeline: `resolveSite()` in pipeline.ts does this with a
 *  single deterministic search and a hostname check against the company slug,
 *  which is both faster and more predictable than asking a model to pick. The
 *  definition is kept because it is a genuinely useful thing to be able to fire
 *  by hand, and because a platform that has it saved can call it from another
 *  agent.
 */
import { siteSchema } from '../schemas.ts';
import type { AgentDefinition } from './types.ts';

export const siteAgent: AgentDefinition = {
  name: 'whisperer-site',
  title: 'Site',
  description: 'Finds a company\'s official homepage and answers with the URL alone.',
  surface: 'utility',
  instructions: 'You find official websites. Answer with the homepage URL only.',
  invocation:
    '\n\nHow you are invoked: the first message names the company and, when known, its site — e.g. `"Supabase" (https://supabase.com)`. Treat that as the whole brief; do not ask a follow-up question, the caller is not watching for one.',
  schema: siteSchema,
  connectors: ['bright-data', 'brave'],
  effort: 'low',
  needsTools: true,
  inPipeline: false,
};
