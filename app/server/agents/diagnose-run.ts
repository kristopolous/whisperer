/** Run the diagnose agent against a real checkout.
 *
 *  Kept apart from the agent definition so the definition stays plain data:
 *  this is the deterministic half — pick search terms out of the report, grep
 *  the source, assemble the excerpts, then ask once.
 */

import { findRelevantCode, excerpt, rankFiles } from '../code.ts';
import type { Issue, Scan } from '../../shared/types.ts';
import { runAgent } from './runtime.ts';
import { diagnoseAgent } from './diagnose.ts';

export interface Diagnosis {
  verdict: 'located' | 'plausible' | 'insufficient' | 'not-a-defect';
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  suspectFiles: { path: string; why: string }[];
  likelyCause: string;
  proposedFix: string;
  regressionTest: string;
  unknowns: string[];
  /** What the search actually looked at, so the verdict can be judged. */
  searched: { terms: string[]; files: string[]; hits: number };
}

export async function diagnoseIssue(
  scan: Scan, issue: Issue, repo: string, emit: (level: 'info' | 'warn', text: string) => void,
): Promise<Diagnosis> {
  // Everything the reporters said, plus the triaged summary — the search terms
  // come from their words, because those are what name the feature.
  const reported = issue.evidence
    .map((id) => scan.mentions.find((m) => m.id === id))
    .filter((m): m is NonNullable<typeof m> => Boolean(m));

  const searchText = [
    issue.title,
    issue.summary,
    issue.impact,
    ...reported.map((m) => `${m.title} ${m.excerpt}`),
  ].join(' ');

  const { terms, hits } = await findRelevantCode(repo, searchText);
  emit('info', `searched ${terms.length} terms, ${hits.length} matching lines`);
  if (hits.length === 0) emit('warn', 'nothing in the checkout matched — the diagnosis will say so');

  const files = rankFiles(hits);
  emit('info', `most relevant: ${files.slice(0, 4).map((f) => f.file).join(', ') || 'none'}`);

  // One excerpt per candidate file, centred on its best match. Bounded hard:
  // the whole prompt has to fit in a local model's context alongside the
  // report, and five well-chosen windows beat forty truncated ones.
  const windows = files.slice(0, 5).map((file) => {
    const best = hits.find((hit) => hit.file === file.file)!;
    return {
      path: file.file,
      matchedTerms: file.terms,
      // Budget per file raised to match: a whole small file is the point, and
      // truncating it at 3k characters recreates the problem windowing caused.
      code: excerpt(repo, file.file, best.line, 40).slice(0, 12_000),
    };
  });

  const diagnosis = await runAgent<Omit<Diagnosis, 'searched'>>(diagnoseAgent, {
    scanId: scan.id,
    note: issue.title.slice(0, 50),
    prompt: `Product: "${scan.company}".

Issue as triaged:
${JSON.stringify({ title: issue.title, kind: issue.kind, severity: issue.severity, summary: issue.summary, impact: issue.impact })}

What the reporters wrote:
${JSON.stringify(reported.map((m) => ({ venue: m.venue, url: m.url, said: m.excerpt.slice(0, 500) })))}

Source excerpts, found by searching the checkout for terms from the report:
${windows.map((w) => `--- ${w.path}  (matched: ${w.matchedTerms.join(', ')})\n${w.code}`).join('\n\n')}

Diagnose against these excerpts. If they do not cover the reported behaviour, say insufficient.`,
    items: windows.length,
    timeoutMs: 420_000,
  });

  return {
    ...diagnosis,
    searched: { terms, files: files.map((f) => f.file), hits: hits.length },
  };
}
