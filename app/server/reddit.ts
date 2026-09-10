import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Mention } from '../shared/types.ts';
import { secret } from './secrets.ts';
import { complaintLanguage } from './search.ts';
import { cached, DAY, HOUR } from './cache.ts';
import { mentionId } from './mention-id.ts';
import { hostOf } from '../shared/name.ts';

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
/** Read one Reddit thread through the API instead of a metered scraper.
 *
 *  Reddit blocks this network unauthenticated, so every reddit.com page in the
 *  corpus was going to Bright Data — a paid request per thread, for a site we
 *  hold credentials to. Free, paced like everything else here, and cached,
 *  because the same thread turns up in several scans.
 *
 *  Returns null when there are no credentials or the lookup fails, so the
 *  caller can fall back to the scraper rather than lose the page. */
/** When a reddit thread was posted.
 *
 *  Its own cache entry rather than a field on the page cache, because that
 *  cache is full of pages stored before the script returned a date and reading
 *  through it would answer null forever. Reddit is half the corpus and a thread
 *  found through a web search arrives undated, so these are the rows that
 *  decide whether the timeline is worth drawing.
 *
 *  Free — reddit's API costs nothing — and asked once a month per URL. */
export async function redditDate(url: string): Promise<string | null> {
  if (!redditReady()) return null;
  try {
    const result = await cached('reddit-date', url, 30 * DAY, () => runScript('', 0, [], url));
    return (result as { ok: boolean; date?: string | null }).date ?? null;
  } catch {
    return null;
  }
}

export async function fetchRedditPage(url: string): Promise<{ text: string; date: string | null } | null> {
  if (!redditReady()) return null;
  try {
    const result = await cached('reddit-page', url, REDDIT_TTL, () => runScript('', 0, [], url));
    const body = result as { ok: boolean; text?: string; date?: string | null };
    const text = body.text ?? '';
    // The post's own timestamp comes back with it. Reddit is half the corpus,
    // and a thread found through a web search arrives with whatever date the
    // search engine guessed — usually none.
    return result.ok && text.length > 200 ? { text, date: body.date ?? null } : null;
  } catch {
    return null;
  }
}

function runScript(
  query: string, limit: number, subs: string[] = [], url = '', threads = 5, target = 0,
): Promise<{
  ok: boolean; mentions?: RawMention[]; error?: string; requests?: number;
  subreddits?: string[]; text?: string; date?: string | null;
}> {
  return new Promise((resolve) => {
    const args = url
      ? [SCRIPT, '--url', url]
      : [SCRIPT, '--query', query, '--limit', String(limit)];
    if (!url) args.push('--with-comments', String(threads));
    if (!url && target) args.push('--target', String(target));
    if (!url && subs.length) args.push('--subs', subs.join(','));
    const child = spawn('python3', args, {
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
  /** Which subreddit it came from, when it came from a dedicated one. */
  subreddit?: string | null;
  /** `hot` or `new`, for items pulled from a product's own subreddit. */
  listing?: string;
}


/** Search Reddit for every alias of the company and normalise the hits into
 *  `Mention`s. Returns `null` when Reddit isn't configured so callers keep
 *  their normal path.
 *
 *  Worth having even though `site:reddit.com` queries already run: those return
 *  whatever a general-purpose crawler indexed and ranked, which for Reddit is
 *  mostly the post and rarely the thread under it. This asks Reddit itself, and
 *  the comment bodies are where people actually say what went wrong — the post
 *  is a question, the replies are the complaint. */
/** Plausible names for a product's own subreddit, best first.
 *
 *  Guessing from the brand alone is not enough, and Bolt is why. The bare name
 *  gives `r/bolt`, which does not exist; meanwhile the footprint stage had
 *  already found `r/boltnew` and `r/boltnewbuilders` by searching, and they
 *  were being ignored. Seven requests were spent instead on a site-wide sweep
 *  that returned tow bar fittings, motorcycle fairings and Pokémon.
 *
 *  It also found `r/BoltEV`, `r/Yamahabolt` and `r/BoltTheSuperdog`, so the
 *  discovered list cannot simply be trusted either — the same name belongs to a
 *  car, a motorbike and a dog. The domain settles it: `bolt.new` reduces to
 *  `boltnew`, which the two right answers start with and the three wrong ones
 *  do not.
 *
 *  Each candidate costs one request to disprove, so the list is capped.
 */
const MAX_CANDIDATES = 3;

function subredditCandidates(aliases: string[], site: string, discovered: string[]): string[] {
  const clean = (value: string) => value.trim().toLowerCase().replace(/^\/?r\//, '').replace(/[^a-z0-9_]/g, '');

  // The WHOLE host with its dots removed, not the registrable name.
  //
  // Taking the name and dropping the TLD gives `bolt` for bolt.new, because
  // `.new` really is the TLD — and `boltev` starts with `bolt`, so r/BoltEV
  // sailed through and put forty-seven Chevrolet posts in the corpus. The whole
  // host is what distinguishes the product: `boltnew` matches r/boltnew and
  // r/boltnewbuilders and matches none of the car, the motorbike or the dog.
  const hostToken = clean(hostOf(site).replace(/\./g, ''));
  const brandToken = clean(aliases[0] ?? '');

  const names = discovered
    .map(clean)
    .filter((name) => name.length >= 3 && name.length <= 21);

  // Tiered, and the tiers do not mix. A host match is strong evidence about
  // WHICH product is meant, so when there is one, a mere brand-prefix match is
  // not a weaker candidate — it is a different subject with a similar name, and
  // adding it costs both requests and a corpus full of somebody else's users.
  const byHost = hostToken.length >= 4 ? names.filter((n) => n.startsWith(hostToken)) : [];
  const byBrand = brandToken.length >= 3
    ? names.filter((n) => n === brandToken || n.startsWith(brandToken))
    : [];

  // Shortest first, which puts the plain community ahead of its spin-offs:
  // r/gimp before r/gimptutorials, r/replit before r/replitbuilders.
  const chosen = (byHost.length ? byHost : byBrand).sort((a, b) => a.length - b.length);

  // The bare tokens are a last resort, for a product whose subreddit nobody
  // found by searching. Only when nothing was discovered — guessing alongside
  // known-good answers just spends requests to be told no.
  const guesses = chosen.length ? [] : [hostToken, brandToken].filter((t) => t.length >= 3);

  return [...new Set([...chosen, ...guesses])].slice(0, MAX_CANDIDATES);
}

/** How long a Reddit pull stays good.
 *
 *  Long, and that is the point. Reddit answers a script app that leans on it
 *  with a throttle before it answers with a revoked token, so the cheapest
 *  request is the one not made. Two hours still catches a day's complaints
 *  across the several scans somebody runs while working. */
const REDDIT_TTL = 2 * HOUR;

/** Does this text name one of the things the resolver said it is NOT?
 *
 *  Matched on whole words so "gimp" is not found inside "gimpy", and against
 *  the body as well as the title — a personals ad does not put the giveaway in
 *  its title. */
function wrongSubject(text: string, exclude: string[]): boolean {
  if (exclude.length === 0) return false;
  const haystack = text.toLowerCase();
  return exclude.some((term) => {
    const needle = term.toLowerCase().trim();
    if (needle.length <= 2) return false;
    return new RegExp(`(^|[^a-z])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i')
      .test(haystack);
  });
}

export interface RedditOptions {
  perAlias?: number;
  /** How many threads to expand into their comments. Each costs one request,
   *  and the comments are where the complaints actually are — a post is usually
   *  the question and the replies are the experience. */
  threads?: number;
  /** Stop once this many items are collected. Listings paginate at one request
   *  per hundred, so a big sample is cheap in requests and only the comment
   *  reads are really rationed. */
  target?: number;
  /** Unrelated things sharing the name, from the resolve agent. */
  exclude?: string[];
  /** The resolved site, which is the best evidence for which subreddit is the
   *  right one when several share a name. */
  site?: string;
  /** Subreddits the footprint stage already found by searching. */
  discovered?: string[];
}

export async function searchReddit(
  aliases: string[],
  emit?: (level: 'info' | 'warn', text: string) => void,
  options: RedditOptions = {},
): Promise<Mention[] | null> {
  const { perAlias = 1_500, threads = 40, target = 3_000, exclude = [], site = '', discovered = [] } = options;
  if (!redditReady()) {
    emit?.('info', 'reddit: no credentials, so its own API was not asked (search still covers reddit.com)');
    return null;
  }
  const mentions: Mention[] = [];
  const seen = new Set<string>();
  const subs = subredditCandidates(aliases, site, discovered);

  for (const alias of aliases) {
    // Cached, because the alternative is paying the full request budget again
    // every time somebody re-runs a scan they are iterating on.
    const res = await cached(
      'reddit', `${alias}:${perAlias}:${threads}:${target}:${subs.join(',')}`, REDDIT_TTL,
      () => runScript(alias, perAlias, subs, '', threads, target),
    );
    if (!res.ok) {
      emit?.('warn', `reddit search for "${alias}" failed — ${(res.error ?? 'unknown').slice(0, 140)}`);
      continue;
    }
    if (res.requests) {
      emit?.('info', `reddit: ${res.requests} API requests for "${alias}"`
        + (res.subreddits?.length ? ` (r/${res.subreddits.join(', r/')} plus a site-wide sweep)` : ' (site-wide sweep; no dedicated subreddit)'));
    }
    let dropped = 0;
    for (const raw of (res.mentions ?? [])) {
      if (!raw.url || seen.has(raw.url)) continue;
      // A post from the product's own subreddit is about the product by
      // construction. A site-wide sweep is not, and for a brand that is also an
      // ordinary English word it is mostly not: searching r/all for "gimp"
      // returns fetish personals alongside image editing, and the complaint
      // vocabulary matches those just as happily. So the exclusions the
      // resolver produced apply to swept results and not to the subreddit's.
      if (!raw.subreddit && wrongSubject(`${raw.title} ${raw.excerpt}`, exclude)) {
        dropped += 1;
        continue;
      }
      seen.add(raw.url);
      const excerpt = raw.commentText ? `${raw.excerpt} — comment: ${raw.commentText}` : raw.excerpt;
      mentions.push({
        // From the URL, not a counter. A sequence number depends on the order
        // results came back in, so the same thread was `rdt1626` one run and
        // something else the next — and every issue citing it lost its source.
        id: mentionId(raw.url),
        venue: 'reddit',
        title: raw.title,
        url: raw.url,
        date: raw.date ?? null,
        author: raw.author ?? null,
        excerpt,
        engagement: raw.engagement,
        sentiment: 'neutral',
        score: 0,
        // Somebody posting on Reddit is discussion by construction — this is
        // never a listing or an SEO roundup, which is most of what the search
        // path has to filter out.
        discussion: true,
        // Which subreddit, and whether it was hot or new, is worth keeping:
        // "r/gimp, hot" is a different weight of evidence from one hit in a
        // site-wide sweep.
        themes: raw.subreddit ? [`r/${raw.subreddit}`, ...(raw.listing ? [raw.listing] : [])] : [],
        complaint: complaintLanguage(`${raw.title} ${excerpt}`),
      });
    }
    if (dropped) {
      emit?.('info', `reddit: dropped ${dropped} swept post(s) about something else of the same name`);
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
