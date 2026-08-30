/** Listen to the live Bluesky firehose and pull out real complaints as they are
 *  posted. No search ranking, no relevance filter, no company — every post on
 *  the network, matched for someone saying something is broken.
 *
 *  Run: npx tsx scripts/gripe-hunt.ts [seconds] */
const seconds = Number(process.argv[2] ?? 45);

const COMPLAINT = /\b(is|are|has been|keeps?) (broken|down|crashing)\b|\bdoesn'?t work\b|\bnot working\b|\bwon'?t (load|open|start|save|connect)\b|\bkeeps? crashing\b|\bso (frustrating|buggy|slow)\b|\bunusable\b|\bterrible (ux|interface|design)\b|\bwhy (is|does) .{0,40}(broken|so slow|not work)/i;

const socket = new WebSocket('wss://jetstream2.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post');
const found: { at: string; did: string; text: string; uri: string }[] = [];
let seen = 0;

socket.addEventListener('message', (event) => {
  try {
    const frame = JSON.parse(String(event.data));
    const record = frame?.commit?.record;
    const text = record?.text;
    if (typeof text !== 'string') return;
    seen += 1;
    if (!COMPLAINT.test(text)) return;
    found.push({
      at: record.createdAt ?? new Date().toISOString(),
      did: frame.did,
      text: text.replace(/\s+/g, ' ').trim(),
      uri: `https://bsky.app/profile/${frame.did}/post/${frame.commit.rkey}`,
    });
  } catch { /* malformed frame */ }
});

await new Promise<void>((resolve) => {
  socket.addEventListener('open', () => console.log(`listening to the whole network for ${seconds}s…\n`));
  setTimeout(() => { socket.close(); resolve(); }, seconds * 1000);
});

const ageSec = (iso: string) => Math.round((Date.now() - Date.parse(iso)) / 1000);
console.log(`${seen} posts seen, ${found.length} complaints\n`);
for (const c of found.slice(0, 12)) {
  console.log(`  ${String(ageSec(c.at)).padStart(4)}s ago  ${c.text.slice(0, 150)}`);
  console.log(`            ${c.uri}\n`);
}
