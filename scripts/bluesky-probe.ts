/** Can we actually reach Bluesky's open endpoints from here?
 *  Run: npx tsx scripts/bluesky-probe.ts [term] [seconds] */
const term = (process.argv[2] ?? 'gimp').toLowerCase();
const seconds = Number(process.argv[3] ?? 20);

// 1. The documented public AppView, which reportedly 403s for search now.
for (const host of ['https://public.api.bsky.app', 'https://api.bsky.app']) {
  try {
    const res = await fetch(`${host}/xrpc/app.bsky.feed.searchPosts?q=${term}&limit=3`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.text();
    const json = body.trimStart().startsWith('{');
    let note = json ? `${(JSON.parse(body).posts ?? []).length} posts` : 'HTML error page';
    console.log(`searchPosts  ${host.padEnd(30)} ${res.status}  ${note}`);
  } catch (error) {
    console.log(`searchPosts  ${host.padEnd(30)} failed — ${error instanceof Error ? error.message : error}`);
  }
}

// 2. Jetstream: the unauthenticated JSON firehose of the whole network.
console.log(`\nJetstream, ${seconds}s sample of every post on the network:`);
const url = 'wss://jetstream2.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post';
const socket = new WebSocket(url);

let posts = 0;
let matches = 0;
const examples: string[] = [];

socket.addEventListener('message', (event) => {
  try {
    const frame = JSON.parse(String(event.data));
    const text = frame?.commit?.record?.text;
    if (typeof text !== 'string') return;
    posts += 1;
    if (text.toLowerCase().includes(term)) {
      matches += 1;
      if (examples.length < 3) examples.push(text.replace(/\s+/g, ' ').slice(0, 100));
    }
  } catch { /* a malformed frame is not worth failing the probe over */ }
});

socket.addEventListener('error', () => console.log('  websocket error'));

await new Promise<void>((resolve) => {
  socket.addEventListener('open', () => console.log('  connected'));
  setTimeout(() => { socket.close(); resolve(); }, seconds * 1000);
});

console.log(`  ${posts} posts seen in ${seconds}s (~${Math.round(posts / seconds)}/sec, ~${(posts / seconds * 86400 / 1000).toFixed(0)}k/day)`);
console.log(`  ${matches} mentioned "${term}"`);
for (const e of examples) console.log(`    - ${e}`);
