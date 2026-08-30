import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Mention } from '../shared/types.ts';
import { secret } from './secrets.ts';
import { complaintLanguage } from './search.ts';

const SCRIPT = path.resolve(import.meta.dirname, '../../skills/reddit-search/scripts/reddit_search.py');

/** Reddit's credentials, from the same store as every other credential.
 *
 *  They used to come from a Reddit-specific block in data/settings.json, fed by
 *  a Reddit-specific form in the settings panel. That form was removed when
 *  credentials moved inline into the row that needs them, which left the block
 *  behind with nothing writing to it — and, worse, holding the values its own
 *  masking had destroyed.
 *
 *  The masking is the whole story. The panel displayed a secret as `abc…yz`,
 *  loaded that display value into the form field, and saved it back verbatim,
 *  so the stored client id became the literal six-character mask. PRAW then put
 *  it in an HTTP header and Python refused: `'latin-1' codec can't encode
 *  character '\u2026' in position 3` — position 3 being exactly where the
 *  ellipsis sat. It reads like a Reddit or an encoding problem and is neither.
 *
 *  `secret()` reads the dashboard store first and falls back to the
 *  environment, so the working credentials in .env are found with nothing to
 *  re-enter, and there is one place a Reddit credential can come from. */
const REDDIT_ENV = [
  'REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USERNAME', 'REDDIT_PASSWORD',
] as const;

export const redditReady = () => REDDIT_ENV.every((name) => Boolean(secret(name)));

/** Run the PRAW script with the configured credentials on its environment. The
 *  credentials never touch the command line; the subprocess reads them from env. */
function runScript(query: string, limit: number): Promise<{ ok: boolean; mentions?: RawMention[]; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn('python3', [SCRIPT, '--query', query, '--limit', String(limit)], {
      env: {
        ...process.env,
        REDDIT_CLIENT_ID: secret('REDDIT_CLIENT_ID') ?? '',
        REDDIT_CLIENT_SECRET: secret('REDDIT_CLIENT_SECRET') ?? '',
        REDDIT_USERNAME: secret('REDDIT_USERNAME') ?? '',
        REDDIT_PASSWORD: secret('REDDIT_PASSWORD') ?? '',
        REDDIT_USER_AGENT: secret('REDDIT_USER_AGENT') || 'whisperer/1.0 by u/whisperer',
      },
    });
    let out = '', err = '';
    child.stdout.setEncoding('utf8').on('data', (c) => { out += c; });
    child.stderr.setEncoding('utf8').on('data', (c) => { err += c; });
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', (code) => {
      if (code !== 0) return resolve({ ok: false, error: `${err.slice(0, 300) || `exited ${code}`}` });
      try {
        const parsed = JSON.parse(out) as { ok: boolean; mentions?: RawMention[]; error?: string };
        resolve(parsed);
      } catch {
        resolve({ ok: false, error: 'reddit script returned unparsable output' });
      }
    });
  });
}

interface RawMention {
  venue: string;
  title: string;
  url: string;
  author: string | null;
  date: string | null;
  excerpt: string;
  engagement: number | null;
  commentText?: string;
}

let seq = 0;

/** Search Reddit for every alias of the company and normalise the hits into
 *  `Mention`s. Returns `null` when Reddit isn't configured so callers keep
 *  their normal path.
 *
 *  Worth having even though `site:reddit.com` queries already run: those return
 *  whatever a general-purpose crawler indexed and ranked, which for Reddit is
 *  mostly the post and rarely the thread under it. This asks Reddit itself, and
 *  the comment bodies are where people actually say what went wrong — the post
 *  is a question, the replies are the complaint. */
export async function searchReddit(
  aliases: string[],
  emit?: (level: 'info' | 'warn', text: string) => void,
  perAlias = 25,
): Promise<Mention[] | null> {
  if (!redditReady()) {
    emit?.('info', 'reddit: no credentials, so its own API was not asked (search still covers reddit.com)');
    return null;
  }
  const mentions: Mention[] = [];
  const seen = new Set<string>();
  for (const alias of aliases) {
    const res = await runScript(alias, perAlias);
    if (!res.ok) {
      emit?.('warn', `reddit search for "${alias}" failed — ${(res.error ?? 'unknown').slice(0, 140)}`);
      continue;
    }
    for (const raw of (res.mentions ?? [])) {
      if (!raw.url || seen.has(raw.url)) continue;
      seen.add(raw.url);
      const excerpt = raw.commentText ? `${raw.excerpt} — comment: ${raw.commentText}` : raw.excerpt;
      mentions.push({
        id: `rdt${++seq}`,
        venue: 'reddit',
        title: raw.title,
        url: raw.url,
        date: raw.date ?? null,
        author: raw.author ?? null,
        excerpt,
        engagement: raw.engagement,
        sentiment: 'neutral',
        score: 0,
        themes: [],
        // Somebody posting on Reddit is discussion by construction — this is
        // never a listing or an SEO roundup, which is most of what the search
        // path has to filter out.
        discussion: true,
        complaint: complaintLanguage(`${raw.title} ${excerpt}`),
      });
    }
  }
  emit?.('info', `reddit: ${mentions.length} posts and comments `
    + `(${mentions.filter((m) => m.complaint).length} complaint-shaped)`);
  return mentions;
}

/** A single authenticated round-trip used by the Settings "Test connection"
 *  button. Resolves `{ ok, error? }`. */
export async function testReddit(): Promise<{ ok: boolean; error?: string }> {
  if (!redditReady()) return { ok: false, error: 'not configured' };
  const res = await runScript('whisperer', 1);
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}
