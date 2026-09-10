/** Gather what can be known about an input, then ask the resolve agent what it
 *  adds up to.
 *
 *  Deterministic first: a repository URL is a fact with an API behind it, and
 *  asking a model to recall a project's homepage when the host will state it is
 *  the wrong tool. The model is only needed for the judgement — what to call
 *  it, what people search for, and what else shares the name.
 */

import type { Subject } from '../../shared/types.ts';
import { why } from '../errors.ts';
import { braveSearch } from '../search.ts';
import { absoluteUrl, cleanName, hostOf, looksLikeHost } from '../../shared/name.ts';
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

/** Strip exclusions that would filter out the subject itself. */
function dropSelfExclusions(
  subject: Subject,
  emit: (level: 'info' | 'warn', text: string) => void,
): string[] {
  const words = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const names = [subject.name, subject.searchTerm, ...(subject.aliases ?? [])]
    .map(words)
    .filter(Boolean);

  const kept: string[] = [];
  const dropped: string[] = [];
  for (const term of subject.excludeTerms ?? []) {
    const needle = words(term);
    if (!needle) continue;
    const swallows = names.some((name) => name.includes(needle) || needle.includes(name));
    (swallows ? dropped : kept).push(term);
  }

  if (dropped.length) {
    emit('warn', `ignoring exclusion(s) that would filter out the subject itself: ${dropped.join(', ')}`);
  }
  return kept;
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
      emit('warn', `could not search for "${raw}" — ${why(error)}`);
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

    // Facts win over judgement about the same field.
    //
    // The homepage and the clone URL are stated by the host's API, and were
    // already in the evidence above — but they were being handed to the model
    // and then read back out of its answer, so a model that simply omitted one
    // lost it. That is what happened to crawl4ai: GitHub says
    // `homepage: https://crawl4ai.com`, the resolver returned `site: ''`, and
    // every stage downstream ran without a site. This file's own opening
    // paragraph says the host should be trusted for this; now it is.
    //
    // Only blanks are filled, not disagreements. A `homepage` pointing at a
    // docs host when the model named the product site is a judgement worth
    // keeping — but an empty answer is never better than a stated fact.
    const resolved: Subject = { ...subject, input: raw };
    // A bare host is not a URL, and everything downstream treats this as one.
    resolved.site = absoluteUrl(resolved.site);

    // An exclusion must not swallow the subject.
    //
    // Resolving bolt.new produced `searchTerm: "Bolt.new"` with
    // `excludeTerms: ["bolt"]` — meaning "not the Chevrolet, not the fastener",
    // which is a reasonable thought and a ruinous instruction. Every downstream
    // filter drops a mention whose title contains an excluded word, so "Bolt
    // keeps burning credits" was thrown away for naming the product. The scan
    // came back with 614 mentions where its peers found 1000.
    //
    // The test is containment either way: a term is unusable if the brand
    // contains it or it contains the brand. "chevrolet" is a fine exclusion for
    // Bolt; "bolt" is not.
    resolved.excludeTerms = dropSelfExclusions(resolved, emit);
    if (facts) {
      const homepage = String(facts.homepage ?? facts.web_url ?? '').trim();
      const clone = String(facts.clone_url ?? facts.http_url_to_repo ?? raw).trim();
      if (homepage) {
        if (!resolved.site) {
          resolved.site = homepage;
          emit('info', `site taken from the repository's own metadata: ${homepage}`);
        }
      } else {
        // The host was asked and said there is no homepage. That is an answer,
        // and it beats a guess: resolving `hangman-test-1` produced
        // `https://yourhomework.net`, a real and entirely unrelated site, which
        // the crawler then dutifully read for the company's social accounts.
        //
        // But blanking it outright was the wrong conclusion. A repository with
        // no homepage is not a subject with no home — the repository IS the
        // home, and it is a real URL with a README, a link list and an issue
        // tracker on it. `microsoft/markitdown` resolved with high confidence
        // and then produced `site: ""`, so the footprint crawl reported "not a
        // site to crawl", found zero channels, and the scan came back with
        // nothing from the one place its users actually are.
        //
        // Safe now that the own-site filter is path-aware: pointing `site` at
        // github.com/owner/repo excludes that repo's own pages from the corpus
        // without excluding the whole of GitHub with them.
        const page = String(facts.html_url ?? facts.web_url ?? raw).trim();
        if (resolved.site && resolved.site !== page) {
          emit(
            'warn',
            `ignoring "${resolved.site}" — the repository lists no homepage, so the repository `
            + 'itself is the site',
          );
        }
        resolved.site = page;
        emit('info', `no homepage listed, so the repository page is the site: ${page}`);
      }
      if (!resolved.repo && clone) resolved.repo = clone;
      if (resolved.site && homepage && resolved.site !== homepage) {
        emit('info', `note: the repository lists ${homepage} as its homepage, resolved as ${resolved.site}`);
      }
    }
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
    emit('warn', `could not resolve the subject — ${why(error)}`);
    const fallbackName = facts ? String(facts.name ?? cleanName(raw)) : cleanName(raw);
    // A repository URL is a repository URL whether or not anything answered.
    //
    // This used to be `facts ? clone_url : ''`, so when both the model and the
    // host's API had a bad minute, a scan of an unmistakable GitHub URL came
    // back with no repository at all — and everything that needs one silently
    // did nothing: no tracker issues ingested, nothing to diagnose, nothing to
    // fork. The string was right there the whole time.
    const looksLikeRepo = /(^|\/\/)(www\.)?(github\.com|gitlab\.[a-z0-9.-]+|bitbucket\.org)\/[^/]+\/[^/]+/i.test(raw);
    return {
      input: raw,
      name: fallbackName,
      searchTerm: fallbackName,
      aliases: [],
      excludeTerms: [],
      site: absoluteUrl(facts ? String(facts.homepage ?? '') : looksLikeHost(raw) && !looksLikeRepo ? raw : ''),
      repo: facts
        ? String(facts.clone_url ?? facts.http_url_to_repo ?? raw)
        : looksLikeRepo ? raw : '',
      kind: 'unknown',
      summary: '',
      confidence: 'low',
    };
  }
}
