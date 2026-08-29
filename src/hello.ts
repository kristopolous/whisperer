import { client, MODEL } from './client.ts';

const { data: session } = await client.sessions.create({
  agent: {
    spec: {
      model: { name: MODEL },
      instructions: 'You are a concise, helpful assistant.',
    },
  },
});

console.log('session:', session.id);

const stream = await client.sessions.createTurnStream(session.id, {
  input: [{ type: 'user.message', content: 'In two sentences, what is TrueForge?' }],
});

for await (const { data: event } of stream.withMetadata()) {
  if (event.type === 'model.message.delta') process.stdout.write(event.content ?? '');
  if (event.type === 'turn.done') console.log('\n\nstatus:', event.state.status);
}
