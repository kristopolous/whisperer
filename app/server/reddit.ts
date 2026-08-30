import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Mention } from '../shared/types.ts';
import { redditSecret, redditReady } from './settings.ts';

const SCRIPT = path.resolve(import.meta.dirname, '../../skills/reddit-search/scripts/reddit_search.py');

/** Run the PRAW script with the configured credentials on its environment. The
 *  credentials never touch the command line; the subprocess reads them from env. */
function runScript(query: string, limit: number): Promise<{ ok: boolean; mentions?: RawMention[]; error?: string }> {
  const creds = redditSecret();
  return new Promise((resolve) => {
    const child = spawn('python3', [SCRIPT, '--query', query, '--limit', String(limit)], {
      env: {
        ...process.env,
        REDDIT_CLIENT_ID: creds.clientId,
        REDDIT_CLIENT_SECRET: creds.clientSecret,
        REDDIT_USERNAME: creds.username,
        REDDIT_PASSWORD: creds.password,
        REDDIT_USER_AGENT: creds.userAgent,
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
 *  their normal path. */
export async function searchReddit(aliases: string[]): Promise<Mention[] | null> {
  if (!redditReady()) return null;
  const mentions: Mention[] = [];
  for (const alias of aliases) {
    const res = await runScript(alias, 8);
    if (!res.ok) continue;
    for (const raw of (res.mentions ?? [])) {
      mentions.push({
        id: `rdt${++seq}`,
        venue: 'reddit',
        title: raw.title,
        url: raw.url,
        date: raw.date ?? null,
        author: raw.author ?? null,
        excerpt: raw.commentText ? `${raw.excerpt} — comment: ${raw.commentText}` : raw.excerpt,
        engagement: raw.engagement,
        sentiment: 'neutral',
        score: 0,
        themes: [],
      });
    }
  }
  return mentions;
}

/** A single authenticated round-trip used by the Settings "Test connection"
 *  button. Resolves `{ ok, error? }`. */
export async function testReddit(): Promise<{ ok: boolean; error?: string }> {
  if (!redditReady()) return { ok: false, error: 'not configured' };
  const res = await runScript('whisperer', 1);
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}
