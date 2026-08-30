import { assertWritable, authenticatedUser } from '../app/server/channels/fork.ts';

console.log('authenticated as:', await authenticatedUser());
for (const [owner, repo] of [['GNOME', 'gimp'], ['unclecode', 'crawl4ai'], ['kristopolous', 'hangman-test']]) {
  try {
    await assertWritable(owner!, repo!);
    console.log(`  ALLOWED  ${owner}/${repo}`);
  } catch (e) {
    console.log(`  REFUSED  ${owner}/${repo} — ${e instanceof Error ? e.message.slice(0, 76) : e}`);
  }
}
