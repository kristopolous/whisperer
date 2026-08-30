/** Fire one real agent through the runtime and print the recorded run.
 *  Run: npx tsx --env-file=.env scripts/agent-check.ts */
import { buzzAgent } from '../app/server/agents/buzz.ts';
import { recentRuns, runAgent, statsFor } from '../app/server/agents/runtime.ts';

const corpus = [
  { url: 'https://example.com/a', text: 'Deploys keep failing with a cryptic error and support has not replied in a week.' },
  { url: 'https://example.com/b', text: 'Honestly the fastest way to get a working prototype in front of a client. Love it.' },
];

try {
  const result = await runAgent<{ scored: unknown[]; verdict: string }>(buzzAgent, {
    prompt: `Product: "Example". Score every item and write the verdict.\n\n${JSON.stringify(corpus)}`,
    note: 'smoke test',
    items: corpus.length,
    timeoutMs: 240_000,
  });
  console.log('scored:', JSON.stringify(result.scored));
  console.log('verdict:', result.verdict?.slice(0, 160));
} catch (error) {
  console.log('agent failed:', error instanceof Error ? error.message : error);
}

console.log('\nrecorded run:', JSON.stringify(recentRuns(1)[0], null, 2));
console.log('stats:', statsFor(buzzAgent.name));
