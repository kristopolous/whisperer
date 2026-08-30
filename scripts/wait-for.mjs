/** Block until an HTTP endpoint answers, then exit.
 *
 *  Exists so `npm run provision` can start TrueForge and register the agents in
 *  one command without a hand-tuned `sleep`. TrueForge takes an unpredictable
 *  few seconds on a cold start — longer on first run when it is still fetching
 *  its own package — and a fixed sleep is either too short on a slow boot or
 *  wasted time on a warm one.
 *
 *  Usage: node scripts/wait-for.mjs <url> [timeoutSeconds]
 */

const url = process.argv[2];
const timeoutSeconds = Number(process.argv[3] ?? 120);

if (!url) {
  console.error('usage: node scripts/wait-for.mjs <url> [timeoutSeconds]');
  process.exit(2);
}

const deadline = Date.now() + timeoutSeconds * 1000;
let reported = false;

while (Date.now() < deadline) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    // Any answer at all means the listener is up; a 404 on the probe path is
    // still a running server.
    if (response.status > 0) {
      console.log(`${url} is up`);
      process.exit(0);
    }
  } catch {
    if (!reported) {
      console.log(`waiting for ${url}…`);
      reported = true;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

console.error(`${url} did not come up within ${timeoutSeconds}s`);
process.exit(1);
