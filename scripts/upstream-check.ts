/** What the project's own tracker gives us. Run: npx tsx --env-file=.env scripts/upstream-check.ts */
import { repoFor } from '../app/server/repos.ts';
import { fetchUpstreamIssues } from '../app/server/upstream.ts';

for (const company of ['gimp', 'krita', 'hangman-test']) {
  const repo = repoFor(company);
  const source = repo?.tracker ?? repo?.url;
  console.log(`\n=== ${company}  ${source ?? '(no repo configured)'}`);
  if (!source) continue;
  const issues = await fetchUpstreamIssues(source, (l, t) => console.log(`  [${l}] ${t}`), 12);
  for (const i of issues.slice(0, 6)) {
    console.log(`  ${(i.date ?? '').slice(0, 10)}  ${i.title.slice(0, 68)}`);
    if (i.themes.length) console.log(`              labels: ${i.themes.join(', ')}`);
  }
}
