/** Look for people trading on the brand — impersonation, phishing, scams.
 *
 *  Runs in the live pipeline, and is the one agent whose local shape and
 *  exported shape genuinely differ:
 *
 *   - Locally, deterministic search runs the abuse-shaped queries and this
 *     agent is handed the candidate pages to judge in batches. It reaches no
 *     tools at all.
 *   - Exported to a platform, it is saved WITH the connectors below, because
 *     there is nothing else out there to do the searching for it. Remigrating
 *     means the agent does its own retrieval again.
 *
 *  `connectors` therefore records what this agent's work depends on, not what
 *  it is handed on any particular run.
 *
 *  Its hardest requirement is restraint: nearly every candidate is ordinary
 *  coverage that merely uses the brand name, and a false accusation of fraud is
 *  far more damaging than a missed one.
 */
import { abuseSchema } from '../schemas.ts';
import type { AgentDefinition } from './types.ts';

export const abuseAgent: AgentDefinition = {
  name: 'whisperer-abuse',
  title: 'Abuse',
  description: 'Judges candidate pages for impersonation, phishing and scams, and reports only what the evidence supports.',
  surface: 'stage',
  stage: 'abuse',
  instructions: `You look for people abusing a brand's name, and you report only what the evidence supports.

What counts:
- **Impersonation** — accounts, servers or pages posing as the company, its founders or its support staff.
- **Phishing and credential theft** — lookalike domains, fake login or wallet-connect pages, "verify your account" flows.
- **Scams** — fake giveaways, airdrops, investment or refund schemes trading on the brand.
- **Fake support** — DMs offering help that route users off-platform, a pattern in Discord and Telegram communities.
- **Counterfeit** — resold licences, cracked builds, unauthorised listings.
- **Malware** — trojaned packages, installers or extensions using the name.
- **Spam and harassment** — coordinated posting, or brigading aimed at the company or its users.

Rules:
- Report only what you saw. A suspicion with no URL behind it is not a finding.
- A competitor being negative is not abuse. A frustrated user is not abuse. Criticism is not abuse.
- Do not name or target private individuals. Describe the account or the operation, not a person.
- Severity is about exposure: critical = users are losing money or credentials right now; serious = an active impersonation with reach; warning = a lookalike or a stale scam post; good = handled or negligible.
- The recommendation is one concrete action — which platform's report flow, which domain to register or contest, which community to warn.`,
  invocation:
    '\n\nHow you are invoked: the first message names the company and, when known, its site — e.g. `"Supabase" (https://supabase.com)`. Treat that as the whole brief; do not ask a follow-up question, the caller is not watching for one.',
  schema: abuseSchema,
  connectors: ['bright-data', 'brave', 'exa', 'youtube', 'tiktok'],
  effort: 'high',
  inPipeline: true,
};
