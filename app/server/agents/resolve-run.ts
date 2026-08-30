/** Gather what can be known about an input, then ask the resolve agent what it
 *  adds up to.
 *
 *  Deterministic first: a repository URL is a fact with an API behind it, and
 *  asking a model to recall a project's homepage when the host will state it is
 *  the wrong tool. The model is only needed for the judgement — what to call
 *  it, what people search for, and what else shares the name.
 */

import type { Subject } from '../../shared/types.ts';
import { braveSearch } from '../search.ts';
import { cleanName, hostOf, looksLikeHost } from '../../shared/name.ts';
import { resolveAgent } from './resolve.ts';
import { runAgent } from './runtime.ts';

/** Repository metadata straight from the host, when the input was a repo URL. */
async function repoFacts(input: string): Promise<Record<string, unknown> | null> {
  let parsed: URL;
  try {
    parsed = new URL(input.startsWith('http') ? input : `https://${input}`);
  } catch {
    return null;
  }
  const path = parsed.pathname.replace(/^\/+|\/+$|\.git$/g, '');
  if (!path.includes('/')) return null;

  const api = /(^|\.)github\.com$/i.test(parsed.hostname)
    ? `https://api.github.com/repos/${path}`
    : /gitlab/i.test(parsed.hostname)
      ? `${parsed.origin}/api/v4/projects/${encodeURIComponent(path)}`
      : null;
  if (!api) return null;

  try {
    const response = await fetch(api, {
      headers: { Accept: 'application/json', 'User-Agent': 'whisperer' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** What the input is, settled once so nothing downstream has to guess. */
export async function resolveSubject(
  input: string,
  emit: (level: 'info' | 'warn', text: string) => void,
): Promise<Subject> {
  const raw = input.trim();

  const facts = await repoFacts(raw);
  if (facts) {
    emit('info', `${raw} is a repository — reading its metadata`);
  }

  // Search evidence, for anything that is not a repository URL. Names, not
  // opinions: enough for the model to tell a product from a person.
  let hits: { title: string; url: string; description: string }[] = [];
  if (!facts) {
    try {
      hits = (await braveSearch(looksLikeHost(raw) ? hostOf(raw) : `"${raw}"`, 6))
        .map((h) => ({ title: h.title, url: h.url, description: h.description.slice(0, 200) }));
    } catch (error) {
      emit('warn', `could not search for "${raw}" — ${error instanceof Error ? error.message.slice(0, 80) : 'error'}`);
    }
  }

  const evidence = facts
    ? {
      kind: 'repository metadata',
      name: facts.name ?? facts.path,
      fullName: facts.full_name ?? facts.path_with_namespace,
      description: facts.description,
      homepage: facts.homepage ?? facts.web_url,
      language: facts.language,
      stars: facts.stargazers_count ?? facts.star_count,
      openIssues: facts.open_issues_count,
      cloneUrl: facts.clone_url ?? facts.http_url_to_repo ?? raw,
    }
    : { kind: 'search results', hits };

  try {
    const subject = await runAgent<Omit<Subject, 'input'>>(resolveAgent, {
      note: raw.slice(0, 50),
      prompt: `The person typed: ${JSON.stringify(raw)}\n\nEvidence:\n${JSON.stringify(evidence, null, 1)}`,
      timeoutMs: 120_000,
    });

    const resolved: Subject = { ...subject, input: raw };
    emit(
      'info',
      `resolved "${raw}" to ${resolved.name} (${resolved.kind}, ${resolved.confidence} confidence)`
      + `, searching for "${resolved.searchTerm}"`
      + (resolved.excludeTerms.length ? ` and not ${resolved.excludeTerms.slice(0, 3).join(', ')}` : ''),
    );
    return resolved;
  } catch (error) {
    // A failed resolution must not stop a scan. Fall back to reading the input
    // the old way — which is what every scan did before this agent existed.
    emit('warn', `could not resolve the subject — ${error instanceof Error ? error.message.slice(0, 100) : 'error'}`);
    const fallbackName = facts ? String(facts.name ?? cleanName(raw)) : cleanName(raw);
    return {
      input: raw,
      name: fallbackName,
      searchTerm: fallbackName,
      aliases: [],
      excludeTerms: [],
      site: facts ? String(facts.homepage ?? '') : looksLikeHost(raw) ? raw : '',
      repo: facts ? String(facts.clone_url ?? facts.http_url_to_repo ?? raw) : '',
      kind: 'unknown',
      summary: '',
      confidence: 'low',
    };
  }
}
