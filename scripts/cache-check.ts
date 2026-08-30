/** Sanity-check that the disk cache is actually serving repeats.
 *  Run: npx tsx --env-file=.env scripts/cache-check.ts */
import { cacheSize, cacheStats } from '../app/server/cache.ts';
import { braveSearch } from '../app/server/search.ts';

const query = 'site:news.ycombinator.com supabase';

let started = Date.now();
const cold = await braveSearch(query, 5);
const coldMs = Date.now() - started;

started = Date.now();
const warm = await braveSearch(query, 5);
const warmMs = Date.now() - started;

console.log(`cold  ${cold.length} hits  ${coldMs}ms`);
console.log(`warm  ${warm.length} hits  ${warmMs}ms`);
console.log(`identical: ${JSON.stringify(cold) === JSON.stringify(warm)}`);
console.log('stats:', cacheStats());
console.log('on disk:', cacheSize());
