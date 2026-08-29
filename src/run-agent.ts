/**
 * Streams one turn against an inline agent that has the registered MCP servers
 * attached, printing model output and tool activity as it arrives.
 *
 * A turn ends paused whenever the agent needs something from us — tool approval,
 * an answer to a question, or an MCP OAuth login. `turn.done.state.requiredActions`
 * carries those, and we resume by creating another turn with the matching input
 * items. That loop is the whole protocol.
 *
 *   npm run agent -- "what's on r/programming today?"
 *   npm run agent -- --yes "summarize the top post on r/rust"
 */
import { createInterface } from 'node:readline/promises';
import { isEventDelta, mergeEventDelta, type TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { client, MODEL } from './client.ts';
import { mcpServers } from './registry.ts';

const args = process.argv.slice(2);
const autoApprove = args.includes('--yes');
const prompt = args.filter((a) => !a.startsWith('--')).join(' ') || 'What can you do?';

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string) => (autoApprove ? Promise.resolve('y') : rl.question(q));

const { data: session } = await client.sessions.create({
  agent: {
    spec: {
      model: { name: MODEL },
      instructions: 'You are a concise assistant. Prefer tools over guessing.',
      mcpServers: mcpServers.map((m) => ({
        name: m.name,
        // Deferred discovery: schemas load only when the agent reaches for them.
        preload: false,
        // Reads run unattended; anything that writes stops for a human.
        requireApprovalForTools: ['@write', '@destructive'],
      })),
    },
  },
});
console.log(`session ${session.id}\n`);

/** model.message events by id, so deltas can be merged back into a whole message. */
const messages = new Map<string, TrueForgeApi.ModelMessageEvent>();

async function runTurn(input: TrueForgeApi.TurnInputItem[]) {
  const stream = await client.sessions.createTurnStream(session.id, { input });
  let done: TrueForgeApi.TurnDoneEvent | undefined;
  let open = false; // whether we're mid-line streaming assistant text

  for await (const { data: event } of stream.withMetadata()) {
    if (event.type === 'model.message') {
      messages.set(event.id, event);
      continue;
    }

    if (isEventDelta(event)) {
      const base = messages.get(event.id);
      if (base) mergeEventDelta(base, event);
      if (event.content) {
        process.stdout.write(event.content);
        open = true;
      }
      continue;
    }

    // Anything else is structural; break the text line before logging it.
    if (open) {
      process.stdout.write('\n');
      open = false;
    }

    switch (event.type) {
      case 'tool.response':
        console.log(`  ← tool result (${event.content.length} chars)`);
        break;
      case 'thread.created':
        console.log(`  ⇢ subagent thread: ${event.title}`);
        break;
      case 'sandbox.created':
        console.log(`  ⇢ sandbox ${event.sandboxId}`);
        break;
      case 'mcp.auth_required':
        for (const s of event.mcpServers) console.log(`  ! authorize ${s.name}: ${s.authUrl}`);
        break;
      case 'turn.done':
        done = event;
        break;
    }
  }

  if (!done) throw new Error('stream ended without turn.done');
  return done;
}

/** Turn one pause into the input items that unblock it. */
async function respondTo(action: TrueForgeApi.ActionRequiredEvent): Promise<TrueForgeApi.TurnInputItem[]> {
  if (action.type === 'mcp.auth_required') {
    for (const s of action.mcpServers) console.log(`authorize ${s.name} at ${s.authUrl}`);
    await ask('press enter once authorized ');
    return []; // empty input resumes after an OAuth login
  }

  const items: TrueForgeApi.TurnInputItem[] = [];
  for (const call of action.toolCalls) {
    // The tool name lives on the model.message that requested the call.
    const source = messages.get(call.sourceEventId);
    const name = source?.toolCalls?.find((t) => t.id === call.id)?.function?.name ?? call.id;

    if (action.type === 'tool.approval_required') {
      const answer = (await ask(`approve ${name}? [y/N] `)).trim().toLowerCase();
      items.push({
        type: 'user.tool_approval',
        threadId: action.threadId,
        toolCallId: call.id,
        approval: answer === 'y' ? { status: 'allow' } : { status: 'deny', reason: 'denied by user' },
      });
    } else {
      const answer = await ask(`${name} asks: `);
      items.push({
        type: 'user.tool_response',
        threadId: action.threadId,
        toolCallId: call.id,
        content: answer,
      });
    }
  }
  return items;
}

let input: TrueForgeApi.TurnInputItem[] = [{ type: 'user.message', content: prompt }];

// Each pause produces the input for the next turn; the loop ends when a turn
// finishes with nothing outstanding.
for (;;) {
  const done = await runTurn(input);

  if (done.state.status !== 'done') {
    console.error(`\nturn ${done.state.status}:`, 'message' in done.state ? done.state.message : done.state.reason);
    break;
  }
  if (done.state.requiredActions.length === 0) {
    console.log('\n[done]');
    break;
  }

  input = [];
  for (const action of done.state.requiredActions) input.push(...(await respondTo(action)));
}

rl.close();
