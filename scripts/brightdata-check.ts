/** Does Bright Data actually retrieve the pages a plain fetch cannot?
 *  Run: npx tsx --env-file=.env scripts/brightdata-check.ts */
import { brightDataAvailable, fetchContent } from '../app/server/content.ts';

console.log(`token present: ${brightDataAvailable()}\n`);

const urls = [
  // The case it exists for: Reddit blocks unauthenticated fetches outright.
  // Real threads, found by discovery earlier — invented ids return a wrapper
  // around a 404 and prove nothing.
  'https://www.reddit.com/r/Outlook/comments/1w3ifwe/outlook_down_for_you_all/',
  'https://www.reddit.com/r/pokemon/comments/1w23okd/pokemon_xp_is_a_hot_mess/',
  // A control that a plain fetch handles, to prove the comparison is fair.
  'https://news.ycombinator.com/item?id=38001999',
];

for (const url of urls) {
  const started = Date.now();
  const got = await fetchContent(url, '(search snippet placeholder)', 4000);
  console.log(`${got.full ? 'FULL   ' : 'snippet'}  ${Math.round((Date.now() - started) / 1000)}s  ${got.text.length} chars  ${url}`);
  if (got.full) {
    // Bright Data wraps returns in a provenance notice; the page itself is
    // after it, so show the tail rather than the boilerplate.
    const body = got.text.replace(/\s+/g, ' ');
    console.log(`          head: "${body.slice(0, 110)}…"`);
    console.log(`          tail: "…${body.slice(-160)}"`);
  }
}
