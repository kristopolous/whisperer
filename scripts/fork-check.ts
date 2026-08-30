import { ensureFork } from '../app/server/channels/fork.ts';
const upstream = process.argv[2] ?? 'https://github.com/unclecode/crawl4ai';
const fork = await ensureFork(upstream, (l, t) => console.log(`  [${l}] ${t}`));
console.log(`\nfork:     ${fork.fullName}`);
console.log(`upstream: ${fork.upstream}`);
console.log(`created:  ${fork.createdNow ? 'just now' : 'already existed'}`);
console.log(`url:      ${fork.url}`);
