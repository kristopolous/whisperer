/** Walk a site, letting the agent choose the route.
 *
 *  The loop is here rather than in the model: deterministic code fetches, holds
 *  the budget, and enforces that the crawl stays on the site. The agent only
 *  ever answers "what did this page show, and where should we look next" — it
 *  gets no tools and cannot reach the network itself.
 *
 *  Every guard exists because the alternative is a crawler that wanders. A
 *  budget stops it walking a documentation site forever; same-origin stops a
 *  link to Twitter being treated as a page to crawl; a visited set stops the
 *  nav bar sending it round in circles.
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { absoluteUrl } from '../../shared/name.ts';
import type { Profile } from '../../shared/types.ts';
import { cleanText } from '../../shared/html.ts';
import { crawlAgent } from './crawl.ts';
import { runAgent } from './runtime.ts';

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '../../..');
const SKILL = path.join(ROOT, 'skills/extract-social-media/scripts');

/** How many pages of one site are worth opening. Most sites give up their
 *  accounts on the first or second; past half a dozen it is documentation. */
const PAGE_BUDGET = Number(process.env.CRAWL_PAGES ?? 6);

interface Page {
  url: string;
  text: string;
  links: { href: string; label: string }[];
}

/** Render a page and pull out its text and links. */
async function fetchPage(url: string): Promise<Page | null> {
  try {
    const { stdout: html } = await run('bash', [path.join(SKILL, 'scrape.sh'), url], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
      encoding: 'utf8',
    });

    const links: { href: string; label: string }[] = [];
    for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi)) {
      const href = m[1]!.trim();
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;
      try {
        links.push({ href: new URL(href, url).toString(), label: cleanText(m[2] ?? '').slice(0, 60) });
      } catch { /* an unparseable href is not a link */ }
    }

    // De-duplicated, and capped: a documentation site can carry a thousand
    // links, and a prompt full of them crowds out the page itself.
    const seen = new Set<string>();
    const unique = links.filter((l) => !seen.has(l.href) && seen.add(l.href)).slice(0, 120);

    return { url, text: cleanText(html).slice(0, 6_000), links: unique };
  } catch {
    return null;
  }
}

const originOf = (url: string) => { try { return new URL(url).origin; } catch { return ''; } };

/** One page, one identity.
 *
 *  `/CONTRIBUTING` and `/CONTRIBUTING/` are the same page, and a crawl with a
 *  six-page budget that spends two of them on the same document has lost a
 *  third of its budget to a trailing slash. Query strings and fragments go too:
 *  a link with `?ref=footer` is not a different page. */
function canonical(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    parsed.search = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return parsed.toString();
  } catch {
    return url;
  }
}

export async function crawlSite(
  company: string,
  site: string,
  emit: (level: 'info' | 'warn', text: string) => void,
): Promise<{ profiles: Profile[]; notes: string; pagesRead: number }> {
  // Belt and braces with the resolver, which now normalises this. A bare host
  // reaching `new URL` here threw ERR_INVALID_URL and cost a scan its entire
  // read of the company's own website — the kind of failure that is invisible
  // because the fallback to search still returns something.
  const url0 = absoluteUrl(site);
  if (!url0) throw new Error(`not a site to crawl: ${JSON.stringify(site)}`);

  const origin = originOf(url0);
  const queue = [canonical(url0)];
  const visited = new Set<string>();
  const found = new Map<string, Profile>();
  let notes = '';

  while (queue.length && visited.size < PAGE_BUDGET) {
    const url = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);

    const page = await fetchPage(url);
    if (!page) { emit('warn', `could not read ${url}`); continue; }

    const result = await runAgent<{
      profiles: (Profile & { url: string })[];
      visit: string[];
      done: boolean;
      notes: string;
    }>(crawlAgent, {
      note: new URL(url).pathname || '/',
      prompt: `Company: "${company}" — site ${site}

Page: ${url}

Text:
${page.text}

Links on this page:
${JSON.stringify(page.links)}

Pages already read: ${JSON.stringify([...visited])}
Accounts found so far: ${JSON.stringify([...found.values()].map((p) => p.url))}`,
      timeoutMs: 120_000,
    });

    for (const profile of result.profiles ?? []) {
      if (!profile?.url) continue;
      found.set(profile.url.toLowerCase().replace(/\/+$/, ''), {
        platform: profile.platform,
        handle: profile.handle,
        url: profile.url,
        official: profile.official ?? true,
        confidence: 'high',
      });
    }
    if (result.notes) notes = result.notes;

    emit('info', `read ${new URL(url).pathname || '/'} — ${found.size} account(s) so far`);
    if (result.done) break;

    for (const next of result.visit ?? []) {
      // Same site only. An off-site link is an account to record, not a page
      // to crawl, and following one turns a site crawl into a web crawl.
      const target = canonical(next);
      if (originOf(target) !== origin || visited.has(target) || queue.includes(target)) continue;
      queue.push(target);
    }
  }

  emit('info', `crawled ${visited.size} page(s), found ${found.size} account(s)`);
  return { profiles: [...found.values()], notes, pagesRead: visited.size };
}
