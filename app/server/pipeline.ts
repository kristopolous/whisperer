import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  AbuseFinding, BuzzPoint, FeedItem, Issue, LogLevel, Mention, Migration, Profile, Scan, ScanEvent,
  Stage, Subject, TopicPoint, Venue,
} from '../shared/types.ts';
import { brandToken } from '../shared/name.ts';
import { projectFor } from './repos.ts';
import { fetchUpstreamIssues } from './upstream.ts';
import { searchHackerNews } from './sources/hackernews.ts';
import { searchGithubIssues } from './sources/github-issues.ts';
import { findAppReviews } from './sources/appstore.ts';
import { searchReddit } from './reddit.ts';
import { crawlSite } from './agents/crawl-run.ts';
import { fetchAll } from './content.ts';
import { runAgent } from './agents/runtime.ts';
import { digging, isDeep, runLanguages } from './run-context.ts';
import { resolveReporter } from './reporter.ts';
import { mentionId } from './mention-id.ts';
import { describeError } from './errors.ts';
import { enabledLanguages, queriesFor } from './languages.ts';
import { abuseAgent } from './agents/abuse.ts';
import { buzzAgent } from './agents/buzz.ts';
import { healthAgent } from './agents/health.ts';
import { complaintsAgent } from './agents/complaints.ts';
import { subjectMatchAgent } from './agents/subject-match.ts';
import { feedQualityAgent } from './agents/feed-quality.ts';
import { migrationsAgent } from './agents/migrations.ts';
import { topicsAgent } from './agents/topics.ts';
import { verdictAgent } from './agents/verdict.ts';
import {
  braveSearch, braveSearchAll, isHomepage, isLexicalNoise, isOpinionBearing, namesCompany,
  looksLikeComplaint, platformOf, profileHandle, searchWidening, venueOf, windowLabel,
  type SearchHit,
} from './search.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');

export type Log = (level: LogLevel, text: string) => void;
type Emit = Log;

const formatBytes = (n: number) => (n < 1024 ? `${n} B` : `${Math.round(n / 1024)} kB`);

/** Turn an MCP error blob into one readable clause. Kept defensive: the blob can
 *  be a clean error JSON, a nested {"error":{...}} envelope, or an unparsable
 *  pile of bytes — never emit the raw, truncated JSON back into the log. */
function summarizeFailure(content: string): string {
  const live = content.slice(0, 2000);
  // Some backends return a bare "429 Too Many Requests" status line ahead of
  // (or instead of) a JSON body, which the "code"/"status" field match below
  // never sees — catch that shape first so a rate limit reads as one, not as
  // a slice of raw, truncated JSON.
  if (/\b429\b.*too many requests/i.test(live) || /rate.?limit/i.test(live)) return 'rate limited (429)';
  const code = live.match(/"(?:code|status)"\s*:\s*(\d{3})/)?.[1];
  if (code === '429') return 'rate limited (429)';
  if (code) return `HTTP ${code}`;
  const message = live.match(/"(?:message|text|error)"\s*:\s*"([^"]{0,160})/)?.[1];
  if (message) return message.replace(/\\n/g, ' ').replace(/\\"/g, '"').trim();
  // Straight error prose ("list index out of range") with no JSON envelope:
  const plain = live.replace(/\s+/g, ' ').replace(/^["'{}\[\],:]+/, '').trim().slice(0, 160);
  if (plain) return plain;
  return 'no detail returned';
}

/** Retry a stage that failed for a transient reason.
 *
 *  A rate limit or a dropped transport is worth one more attempt; a schema
 *  rejection or a missing model is not, and retrying it just burns minutes.
 */
async function withRetry<T>(label: string, log: Log, fn: () => Promise<T>): Promise<T> {
  const transient = /429|rate.?limit|ECONNRESET|ETIMEDOUT|502|503|504|transport/i;
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!transient.test(message)) throw error;
    log('warn', `${label} hit a transient failure, retrying once — ${message.slice(0, 120)}`);
    return fn();
  }
}

/** Models wrap JSON in prose or fences often enough that this is not optional. */
function parseJson<T>(raw: string): T {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.search(/[{[]/);
  if (start === -1) throw new Error(`no JSON in model output: ${raw.slice(0, 200)}`);
  const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
  return JSON.parse(body.slice(start, end + 1)) as T;
}

/** Run a command with `input` on its stdin and collect stdout. */
/** An exec failure, with the part that says what went wrong.
 *
 *  Node's execFile puts "Command failed: <the command>" in `error.message` and
 *  the actual reason on `error.stderr`, which is dropped by anything that logs
 *  only the message. In development that is merely unhelpful; on a deployed
 *  instance it is the difference between a diagnosable failure and "site scrape
 *  failed" with no cause, on a machine you cannot attach a debugger to.
 *
 *  Common real causes this now surfaces: the interpreter missing from a
 *  service's minimal PATH, a sandboxed /tmp the helper cannot write its cached
 *  binary into, no outbound network, or the skills directory not present in the
 *  deployed tree at all. */
function describeExecFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const e = error as Error & { stderr?: string; code?: number | string; signal?: string };
  const detail = (e.stderr ?? '').toString().trim().split('\n').slice(-4).join(' | ').slice(0, 400);
  const status = e.code !== undefined ? ` (exit ${e.code}${e.signal ? `, ${e.signal}` : ''})` : '';
  return `${e.message.split('\n')[0]}${status}${detail ? ` — ${detail}` : ' — no stderr'}`;
}

/* ---------------------------------------------------------------- presence */

/** Map a company's footprint. The site scrape yields the accounts the company
 *  itself links to (tagged official); a search sweep then adds the unofficial
 *  and third-party channels — subreddits, messaging groups, review platforms,
 *  socials — so the panel shows everything out there, not just the site. */
/** Same-account URLs the model returns inconsistently, collapsed to one key so
 *  they dedupe instead of showing up as separate rows: aliased hosts
 *  (twitter.com/x.com), and per-platform path variants (YouTube's /c/,
 *  /channel/, /@ and bare-name forms) that all point at one channel. */
function canonicalProfileKey(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl.trim().toLowerCase();
  }

  let host = url.hostname.toLowerCase().replace(/^www\./, '');
  const HOST_ALIASES: Record<string, string> = { 'twitter.com': 'x.com' };
  host = HOST_ALIASES[host] ?? host;

  let path = url.pathname.replace(/\/+$/, '').toLowerCase();
  if (host.endsWith('youtube.com')) {
    path = path.replace(/^\/(c|channel|user)\//, '/').replace(/^\/@/, '/');
  } else {
    path = path.replace(/^\/@/, '/');
  }

  return `${host}${path}`;
}

export async function findPresence(
  company: string, site: string, emit: Emit,
): Promise<Profile[]> {
  // Two deterministic sources, no agent loop and no model:
  //
  //  1. the company's own site — render it and classify its outbound links
  //     (skills/extract-social-media). Authoritative when it works, but it is
  //     one HTTP fetch away from being useless: plenty of marketing sites sit
  //     behind a bot check that serves a challenge page instead of the footer.
  //  2. plain web search for the accounts themselves. This is what a person
  //     would do, it costs a few seconds, and it still works when (1) is
  //     blocked.
  //
  // (2) is not a fallback for (1) — they are merged, because the site footer
  // misses community accounts (a subreddit, a Discord) that search finds, and
  // search misses accounts that are only ever linked from the site.
  const merged = new Map<string, Profile>();

  // The site crawl is an agent now: it opens the homepage, decides which of
  // that site's pages are worth reading next, and walks a few of them.
  //
  // A single scrape of the front page only works when a company keeps its
  // accounts in the footer. Plenty keep them behind Community, Contact, or
  // buried in documentation — and a one-shot fetch reports those as "no
  // accounts", which reads as a finding rather than a failure to look.
  try {
    const crawled = await crawlSite(company, site, emit);
    for (const profile of crawled.profiles) {
      merged.set(canonicalProfileKey(profile.url), profile);
    }
    if (crawled.notes) emit('info', `crawl: ${crawled.notes.slice(0, 160)}`);
  } catch (error) {
    emit('warn', `site crawl failed: ${describeExecFailure(error)} — falling back to search`);
  }

  const fromSite = merged.size;
  const brand = brandToken(company, site);

  // The company's own name plus each platform. Cheap, and it is exactly the
  // query a person types.
  const queries = [
    `${brand} official x.com twitter`,
    `${brand} linkedin company page`,
    `${brand} github`,
    `${brand} youtube channel`,
    `${brand} discord community invite`,
    `${brand} subreddit reddit`,
    `${brand} instagram tiktok`,
  ];

  const hits = await braveSearchAll(queries, 10, (query, message) =>
    emit('warn', `search "${query}" failed — ${message}`));

  for (const hit of hits) {
    const platform = platformOf(hit.url);
    if (!platform) continue;
    // Reject posts, statuses, hashtags and topic pages — only account homes.
    const handle = profileHandle(hit.url);
    if (!handle) continue;

    const key = canonicalProfileKey(hit.url);
    if (merged.has(key)) continue;

    // "Official" means the account looks like it belongs to the company: its
    // handle contains the company name. Anything else is a real channel about
    // the company but not run by it, and the dashboard splits on exactly that.
    const slug = company.toLowerCase().replace(/[^a-z0-9]/g, '');
    const normalized = handle.toLowerCase().replace(/[^a-z0-9]/g, '');
    const official = Boolean(slug) && normalized.includes(slug);

    merged.set(key, {
      platform,
      handle,
      url: hit.url,
      official,
      confidence: official ? 'high' : 'low',
    });
  }

  const profiles = [...merged.values()].sort((a, b) =>
    a.platform.localeCompare(b.platform) || a.handle.localeCompare(b.handle));

  emit('info', `${profiles.length} accounts (${fromSite} from the site, ${profiles.length - fromSite} from search)`);
  return profiles;
}

/** Turn "Lovable" into a URL. A domain-shaped input is taken at its word.
 *
 *  This used to be an agent turn. It is one web search: the first result that
 *  sits on a plausible company domain wins. That is both faster and steadier
 *  than asking a model to recall a URL, and it cannot hallucinate a domain that
 *  does not exist. */
export async function resolveSite(company: string, emit: Emit): Promise<string> {
  const trimmed = company.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[\w-]+(\.[\w-]+)+$/.test(trimmed)) return `https://${trimmed}`;

  // Directories, app stores and social profiles all rank for a company name;
  // none of them is the company's own site.
  const NOT_THEIRS =
    /(wikipedia|crunchbase|linkedin|twitter|x\.com|facebook|instagram|youtube|github|reddit|medium|substack|producthunt|g2\.com|capterra|trustpilot|glassdoor|apps\.apple|play\.google|sourceforge|stackshare)\./i;

  const hits = await braveSearch(`${trimmed} official website`, 10);
  const slug = trimmed.toLowerCase().replace(/[^a-z0-9]/g, '');

  const candidates = hits.filter((hit) => !NOT_THEIRS.test(hit.url));
  // Strongly prefer a domain that actually contains the company name.
  const owned = candidates.find((hit) => {
    try {
      return new URL(hit.url).hostname.toLowerCase().replace(/[^a-z0-9]/g, '').includes(slug);
    } catch {
      return false;
    }
  });

  const chosen = owned ?? candidates[0] ?? hits[0];
  if (!chosen) throw new Error(`no search result for "${trimmed}" — cannot resolve a site`);

  const origin = new URL(chosen.url).origin;
  emit('info', `resolved "${trimmed}" to ${origin}`);
  return origin;
}

/* --------------------------------------------------------------- discovery */

/** The sites that make up a venue, for the venues with no reader of their own.
 *
 *  What "search blogs harder" means in practice: the same complaint vocabulary,
 *  aimed at the handful of hosts where that kind of writing lives, rather than
 *  hoping a general web sweep surfaces them.
 *
 *  `forum` is derived rather than listed, because a product's forum is its own:
 *  it is whatever the footprint found, which is why editing Sources feeds
 *  straight back into what a dig can reach. */
function venueHosts(venue: string, profiles: Profile[]): string[] {
  const listed: Record<string, string[]> = {
    blog: ['medium.com', 'dev.to', 'substack.com', 'hashnode.dev', 'blogspot.com', 'wordpress.com'],
    review: ['trustpilot.com', 'g2.com', 'capterra.com', 'producthunt.com', 'sitejabber.com'],
    x: ['x.com'],
    youtube: ['youtube.com'],
    linkedin: ['linkedin.com'],
    stackoverflow: ['stackoverflow.com', 'stackexchange.com', 'superuser.com'],
    discord: ['discord.com'],
    telegram: ['t.me'],
  };
  if (listed[venue]) return listed[venue]!;

  if (venue === 'forum') {
    const hosts = profiles
      .filter((profile) => /forum|discourse|community|support/i.test(`${profile.platform} ${profile.url}`))
      .map((profile) => {
        try {
          return new URL(profile.url).hostname.replace(/^www\./, '');
        } catch {
          return '';
        }
      })
      .filter(Boolean);
    return [...new Set(hosts)];
  }
  return [];
}

/** The term to search for, and what it must not be confused with.
 *
 *  Prefers the resolved subject over anything inferred from the raw input:
 *  "gimp image editor" resolves to GIMP, which is what people write, rather
 *  than to a phrase that occurs nowhere. Falls back to the old derivation for
 *  scans that predate the resolve step. */
function searchIdentity(company: string, site: string, subject?: Subject) {
  if (subject?.searchTerm) {
    return { brand: subject.searchTerm, exclude: subject.excludeTerms ?? [], aliases: subject.aliases ?? [] };
  }
  return { brand: brandToken(company, site), exclude: [], aliases: [] };
}

/** Does a result look like it is about something else that shares the name?
 *
 *  The resolve step names the collisions — "bolt" for bolt.new, "image editor"
 *  for GIMP — and a hit whose title leads with one of them is almost always the
 *  other thing. Checked against the title only: an excluded word appearing deep
 *  in a page's description is usually incidental. */
function isWrongSubject(hit: SearchHit, exclude: string[]): boolean {
  if (exclude.length === 0) return false;
  const title = hit.title.toLowerCase();
  return exclude.some((term) => {
    const needle = term.toLowerCase().trim();
    return needle.length > 2 && new RegExp(`(^|[^a-z])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i').test(title);
  });
}

/** How far back still counts as current for a brand watch. A year is the outer
 *  edge of useful: a complaint from thirteen months ago has either been fixed
 *  or has stopped being news. */
const RECENT_MONTHS = 12;

/** Volume controls, env-overridable because the right numbers depend on both
 *  the subject and the Brave plan.
 *
 *  Why the corpus was tiny: without pagination a query could return at most 20
 *  results however much the internet had to say, and the result was then cut to
 *  60. Twenty queries against a thirty-year-old program with a huge, vocal user
 *  base produced 121 raw hits. That is not what the internet holds; it is what
 *  20 × 20, minus heavy overlap between queries, minus rate-limited failures,
 *  arithmetically comes to.
 *
 *  Paging costs real time: Brave's free tier is one request per second, so each
 *  extra page across twenty queries is another twenty seconds of wall clock.
 *  Three pages is the default because it roughly triples the corpus for about a
 *  minute more, and going wider is a plan question, not a code one. */
const SEARCH_PAGES = Number(process.env.SEARCH_PAGES ?? 6);

/** What a deep run multiplies the volume caps by.
 *
 *  Deliberately applied to the caps and not to the page count. Paging deeper is
 *  the lever that does not work: measured here, going from three pages to six
 *  raised the raw count by about a sixth, because the same thirty queries were
 *  competing for the same results. What actually limits the corpus is that the
 *  recency ladder stops the moment it has enough — on Bolt.new it settled on
 *  "last month" with 426 results and never looked further back — and that the
 *  finished list is then cut to a cap. Deep lifts both. */
const DEEP_FACTOR = Number(process.env.DEEP_FACTOR ?? 4);
const deeper = (n: number) => (isDeep() ? n * DEEP_FACTOR : n);

/** How many results discovery wants before it stops widening its window. */
const DISCOVERY_TARGET = Number(process.env.DISCOVERY_TARGET ?? 400);

/** How many complaint-shaped results to gather before the complaint pass stops
 *  widening. Separate from the general target because this is the half of the
 *  corpus the product actually exists to act on. */
const COMPLAINT_TARGET = Number(process.env.COMPLAINT_TARGET ?? 300);

/** How many mentions the corpus keeps.
 *
 *  Deliberately much larger than the number the model stages will read. Rows
 *  are nearly free — they are a title, a URL and a snippet — while scoring is
 *  minutes per few dozen. Conflating the two is what made "how much did we
 *  find" and "how much can we afford to think about" the same number, and the
 *  smaller of the two won.
 *
 *  Raising pages costs wall-clock rather than breadth of window: Brave paginates
 *  to ten and rate-limits to one request a second, so each extra page across
 *  thirty queries is another thirty seconds. Six pages is roughly a thousand raw
 *  results before dedup and filtering. Past that it is a Brave plan question. */
const MENTION_CAP = Number(process.env.MENTION_CAP ?? 1000);

/** The few questions whose best answers are old by nature. Everything else goes
 *  through the widening recent sweep. */
const HISTORICAL_QUERIES = (company: string) => [
  `"switched from ${company}"`,
  `"${company}" vs`,
  `"we use ${company}"`,
];

const isRecent = (date: string) =>
  Date.now() - Date.parse(date) < RECENT_MONTHS * 30.44 * 86_400_000;

/** Sort order for the corpus: real discussion first, then recency, newest
 *  first. This decides what survives the cut to sixty, so it is doing more work
 *  than an ordinary display sort. */
function rankByDiscussionThenRecency(a: SearchHit, b: SearchHit): number {
  const tier = (hit: SearchHit) => {
    const opinion = isOpinionBearing(hit) ? 0 : 3;
    if (hit.date && isRecent(hit.date)) return opinion;
    if (!hit.date) return opinion + 1;
    return opinion + 2;
  };
  const byTier = tier(a) - tier(b);
  if (byTier !== 0) return byTier;
  return (b.date ?? '').localeCompare(a.date ?? '');
}

/** Open issues from the company's own tracker, when one is configured.
 *
 *  Silent and empty when there is no repository for this company — most scans
 *  are of products whose source nobody here has. */
async function upstreamMentions(
  company: string, site: string, emit: Emit, subject?: Subject,
): Promise<Mention[]> {
  // What a person specified wins; what the resolver found is the fallback.
  //
  // This used to read config/repos.json and nothing else, so a scan that had
  // successfully worked out a company's repository still ingested no tracker
  // issues unless somebody had also written it into a config file by hand —
  // discovery answered the question and the answer went unused.
  const source = projectFor(company, { repo: subject?.repo }).effective.tracker;
  if (!source) return [];

  try {
    return await fetchUpstreamIssues(source, emit);
  } catch (error) {
    emit('warn', `tracker lookup failed — ${error instanceof Error ? error.message.slice(0, 100) : 'error'}`);
    return [];
  }
}

/** Read the items the complaint vocabulary could not place, and flag the ones
 *  that report a real fault.
 *
 *  Runs only when it can change something. The flag exists to guarantee
 *  complaint-shaped items a share of the model's reading budget, so once that
 *  share is already full, finding more candidates changes nothing and costs
 *  minutes. Measured on r/GIMP: the widened vocabulary flagged 49 of 159 and
 *  this pass added 9 — worth having when a corpus looks quiet, never worth
 *  running first.
 */
/** A third of the reading budget. Below this the pass is worth its minutes;
 *  above it, more candidates than slots is not a problem worth paying to have. */
const complaintShare = () => Math.floor(SCORE_BUDGET / 3);

/** Did this come from the product's own subreddit, where the topic is settled? */
const fromOwnCommunity = (m: Mention) => (m.themes ?? []).some((t) => t.startsWith('r/'));
const TRIAGE_BATCH = 30;
/** How many unplaced items to read at most. Each batch is about twenty seconds
 *  of local model time, so this is the ceiling on what the pass can cost. */
const TRIAGE_CAP = Number(process.env.COMPLAINT_TRIAGE_CAP ?? 90);

/* ------------------------------------------------- subject disambiguation --*/

const SUBJECT_BATCH = 30;

/** How many ambiguous items to read at most.
 *
 *  Tied to the scoring budget rather than picked, because that is the slice
 *  that gets used: everything past it is collected and listed but never read,
 *  so a wrong-subject item sitting in the tail costs a row in Discovery and
 *  nothing else. The corpus is already ranked, and the ambiguous list keeps
 *  that order, so this reads the ambiguous items that are actually going to be
 *  scored and triaged.
 *
 *  It matters more than it looks. On GIMP, 84% of a thousand mentions carry
 *  only the bare name — "gimp" is a search for motorbike parts as often as an
 *  image editor — so a fixed cap of a hundred would have left most of the
 *  scored slice unchecked. A function, not a const, because SCORE_BUDGET is
 *  declared further down the file. */
const subjectCap = () => Number(process.env.SUBJECT_MATCH_CAP ?? SCORE_BUDGET);

/** Tokens whose presence settles the topic without asking anybody.
 *
 *  A name with a dot or a space in it is not hit by accident — "bolt.new",
 *  "truefoundry.com" and "Bright Data" do not turn up in a thread about
 *  fasteners. A bare word like "bolt", "gimp" or "lovable" does, constantly.
 *  So the unambiguous forms decide the easy cases for nothing and the model is
 *  paid only for the genuinely ambiguous remainder — the same division of
 *  labour as the complaint vocabulary and its triage pass. */
export function settlingTokens(company: string, site: string, subject?: Subject): string[] {
  const host = site.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0];
  const names = [subject?.searchTerm ?? '', subject?.name ?? '', company, ...(subject?.aliases ?? [])];
  return [...new Set([host, ...names])]
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 3 && (t.includes('.') || t.includes(' ')));
}

const compact = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** The same names with the punctuation taken out, for matching against a URL.
 *
 *  Because a community names itself after the product without the punctuation.
 *  138 of the 150 "ambiguous" Bolt.new mentions were from r/boltnewbuilders —
 *  posts like "I need to cancel my subscription" that are unmistakably about
 *  the product and never once write its name, so every literal test misses them
 *  and the model would have been paid to read a question it cannot answer from
 *  the text either. Compacted, the URL says `boltnewbuilders` and the subject
 *  says `boltnew`, and the answer is free.
 *
 *  Six characters, not four, and that is the whole safety margin: `gimp`
 *  inside a URL would take r/gimpsuits with it, which is the exact collision
 *  this pass exists to catch. Short bare names stay ambiguous and go to the
 *  model, where they belong. */
export function compactTokens(company: string, site: string, subject?: Subject): string[] {
  const host = site.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0];
  const names = [subject?.searchTerm ?? '', subject?.name ?? '', company, host, ...(subject?.aliases ?? [])];
  return [...new Set(names.map(compact))].filter((t) => t.length >= 6);
}

/** Drop mentions that are about something else with the same name.
 *
 *  Returns the corpus with the impostors removed. Never throws: a failed batch
 *  leaves those items in, which is where they already were, and losing a whole
 *  discovery run over a disambiguation pass would be a bad trade. */
async function dropWrongSubject(
  company: string, site: string, mentions: Mention[], emit: Emit, subject?: Subject,
): Promise<Mention[]> {
  const settling = settlingTokens(company, site, subject);
  const compacted = compactTokens(company, site, subject);

  const ambiguous = mentions.filter((m) => {
    // Its own community already answers the topic question — everything in
    // r/GIMP is about GIMP — so it is never worth paying to ask again.
    if (fromOwnCommunity(m)) return false;
    const text = `${m.title} ${m.excerpt} ${m.url}`.toLowerCase();
    if (settling.some((token) => text.includes(token))) return false;
    // The URL only, compacted. Running this over the body text would match
    // across word boundaries and quietly settle things it should not.
    const url = compact(m.url);
    return !compacted.some((token) => url.includes(token));
  });

  if (ambiguous.length === 0) {
    emit('info', `subject check: every mention names ${subject?.searchTerm ?? company} unambiguously`);
    return mentions;
  }

  const reading = ambiguous.slice(0, subjectCap());
  emit(
    'info',
    `subject check: ${mentions.length - ambiguous.length} name it outright, reading ${reading.length}`
    + `${ambiguous.length > reading.length ? ` of ${ambiguous.length}` : ''} that could be something else`,
  );

  // What the model compares against. Assembled from the resolve step rather
  // than from the raw input, because "what it is" is the half of the question
  // a name cannot answer.
  const described = [
    `Subject: ${subject?.name || company}`,
    subject?.kind && subject.kind !== 'unknown' ? `What it is: ${subject.kind}` : '',
    subject?.summary ? `Description: ${subject.summary}` : '',
    site ? `Its website: ${site}` : '',
    subject?.aliases?.length ? `Also called: ${subject.aliases.join(', ')}` : '',
    subject?.excludeTerms?.length
      ? `Known to be confused with: ${subject.excludeTerms.join(', ')}` : '',
  ].filter(Boolean).join('\n');

  const wrong = new Set<Mention>();
  for (let start = 0; start < reading.length; start += SUBJECT_BATCH) {
    const batch = reading.slice(start, start + SUBJECT_BATCH);
    try {
      const result = await runAgent<{ verdict: { index: number; topic?: string; same: boolean }[] }>(subjectMatchAgent, {
        prompt: `${described}\n\nItems:\n`
          + batch.map((m, index) =>
            // The URL included: a host and a slug say what a page is more
            // reliably than a ranker's summary of it, and cost nothing.
            `${index}: ${m.url}\n${`${m.title} ${m.excerpt}`.slice(0, 300).replace(/\s+/g, ' ')}`).join('\n'),
        items: batch.length,
        note: `ambiguous ${start + 1}–${start + batch.length}`,
        timeoutMs: 180_000,
      });
      for (const verdict of result.verdict ?? []) {
        const mention = batch[verdict.index];
        if (!mention || verdict.same !== false) continue;
        wrong.add(mention);
        // Said out loud, with the topic the model gave it. A silent filter that
        // removes a third of the corpus is indistinguishable from a search that
        // found nothing, and this is the log line that tells them apart.
        emit('info', `not this subject — "${mention.title.slice(0, 70)}" reads as ${verdict.topic || 'something else'}`);
      }
    } catch (error) {
      emit('warn', `subject check batch failed — ${error instanceof Error ? error.message.slice(0, 100) : 'error'}`);
    }
  }

  if (wrong.size === 0) {
    emit('info', 'subject check: everything read was about this subject');
    return mentions;
  }
  emit('warn', `subject check: dropped ${wrong.size} mention(s) about something else with the same name`);
  return mentions.filter((m) => !wrong.has(m));
}

async function triageUnflagged(company: string, mentions: Mention[], emit: Emit): Promise<number> {
  const flagged = mentions.filter((m) => m.complaint).length;
  if (flagged >= complaintShare()) {
    emit('info', `complaint triage skipped — ${flagged} already flagged, which fills the reading share`);
    return 0;
  }

  // Only what the pattern could not place, and only things somebody wrote.
  //
  // The product's own subreddit goes first. Its topic is established — every
  // post in r/GIMP is about GIMP — so the model is left with one question
  // instead of two, and a budget spent there buys a judgement rather than a
  // topicality check it would have had to make anyway.
  const unplaced = mentions
    .filter((m) => !m.complaint && (m.discussion ?? true) && m.excerpt.length > 40)
    .sort((a, b) => Number(fromOwnCommunity(b)) - Number(fromOwnCommunity(a)))
    .slice(0, TRIAGE_CAP);
  if (unplaced.length === 0) return 0;

  emit('info', `complaint triage: ${flagged} flagged by vocabulary, reading ${unplaced.length} more`);

  // The post, not the snippet. This decides whether something is a complaint at
  // all, and a search description is a truncated sentence chosen by a ranker —
  // the fault is usually described in the paragraph after it. Cached, so the
  // scoring stage that fetches the same URLs later pays nothing.
  const bodies = await fetchAll(unplaced, (done, total, full) =>
    emit('info', `complaint triage: fetched ${done}/${total} (${full} with full text)`));
  const bodyOf = (mention: Mention) =>
    (bodies.get(mention.url)?.text ?? mention.excerpt).slice(0, 700);

  let found = 0;
  let invented = 0;
  for (let start = 0; start < unplaced.length; start += TRIAGE_BATCH) {
    const batch = unplaced.slice(start, start + TRIAGE_BATCH);
    try {
      const result = await runAgent<{ verdict: { index: number; evidence?: string; isProblem: boolean }[] }>(complaintsAgent, {
        prompt: `Product: "${company}".\n\n`
          + batch.map((m, index) => {
            // Saying where it came from is what lets the model stop asking
            // whether the item is even about this product.
            const origin = fromOwnCommunity(m) ? ' [own community]' : '';
            return `${index}${origin}: ${m.url}\n${`${m.title} ${bodyOf(m)}`.replace(/\s+/g, ' ')}`;
          }).join('\n'),
        items: batch.length,
        note: `unplaced ${start + 1}–${start + batch.length}`,
        timeoutMs: 180_000,
      });
      for (const verdict of result.verdict ?? []) {
        const mention = batch[verdict.index];
        if (!mention || !verdict.isProblem) continue;
        // The quote has to be real.
        //
        // Requiring evidence before the verdict is only worth something if the
        // evidence is checked; otherwise it is a field the model can fill with
        // anything and the ordering has bought nothing. Because the quote must
        // be copied verbatim, this is a substring test — a claim the code can
        // falsify, in the same spirit as running a new regression test against
        // unpatched code before believing a fix.
        if (!quotesTheSource(verdict.evidence, `${mention.title} ${mention.excerpt}`)) {
          invented += 1;
          continue;
        }
        mention.complaint = true;
        found += 1;
      }
    } catch (error) {
      // One failed batch leaves those items unflagged, which is the state they
      // were already in. Never a reason to fail discovery.
      emit('warn', `complaint triage batch failed — ${error instanceof Error ? error.message.slice(0, 100) : 'error'}`);
    }
  }

  emit(
    'info',
    `complaint triage: ${found} more flagged by reading them`
    + (invented ? `, ${invented} rejected for quoting words that are not in the post` : ''),
  );
  return found;
}

/** Does the model's quote actually occur in what it was reading?
 *
 *  Loose about whitespace and case, strict about the words. Models reflow a
 *  quote — collapsing a newline, changing a curly apostrophe — without changing
 *  what it says, and rejecting those would throw away good verdicts. Inventing
 *  a sentence is a different thing entirely and this catches it.
 *
 *  A very short quote is not evidence of anything: "error" appears in plenty of
 *  posts that are answering somebody else's error. */
function quotesTheSource(evidence: string | undefined, source: string): boolean {
  // Compared on words alone: letters, digits and single spaces.
  //
  // Punctuation is where a faithful quote drifts. A model reproducing
  // `Missing "Open" preview window` as `Missing 'Open' preview window` has
  // copied it correctly by any standard that matters, and an earlier version of
  // this normalised curly quotes but not straight ones and threw that verdict
  // away — rejecting a real fault report over a apostrophe. Inventing a
  // sentence is a different thing entirely, and dropping punctuation does not
  // help anyone do it.
  const words = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const quote = words(evidence ?? '');
  // A handful of characters is not evidence: "error" occurs in plenty of posts
  // that are answering somebody else's error.
  if (quote.length < 12) return false;
  return words(source).includes(quote);
}

/** The subject's own repository as `owner/name`, so a source that searches all
 *  of GitHub can leave out the tracker upstream.ts already reads properly. */
function ownRepoOf(subject?: Subject): string | null {
  const url = subject?.repo;
  if (!url) return null;
  const path = url.replace(/\.git$/, '').replace(/^https?:\/\/[^/]+\//, '').replace(/\/+$/, '');
  const [owner, repo] = path.split('/');
  return owner && repo ? `${owner}/${repo}` : null;
}

export { resetSearchBudget, searchSpend } from './search.ts';

export async function findMentions(
  company: string, site: string, profiles: Profile[], emit: Emit, subject?: Subject,
): Promise<Mention[]> {
  // Venue by venue, as site-scoped queries. No agent decides which of these to
  // run or in what order — they all run, every time, and a failure in one is a
  // logged warning rather than a dead stage.
  // Two halves, deliberately.
  //
  // The general half finds who is talking about the product at all. The
  // complaint half goes looking for the words people actually use when
  // something is wrong — "broken", "not working", "slow". Without it the corpus
  // fills with reviews and "best alternatives" roundups, nobody in it is
  // complaining, and the health stage has nothing to triage while sentiment is
  // scored over SEO copy rather than over anyone's experience.
  // What to search for is not always what was typed — see brandToken. Every
  // query below quotes this as an exact phrase, so a descriptive subject like
  // "gimp image editor" would otherwise search for a phrase nobody writes.
  const { brand, exclude } = searchIdentity(company, site, subject);
  if (brand.toLowerCase() !== company.toLowerCase()) {
    emit('info', `searching for "${brand}" rather than the phrase "${company}"`);
  }
  if (exclude.length) emit('info', `excluding results about: ${exclude.join(', ')}`);

  // Two query sets, run as two passes and merged with a guaranteed share each.
  //
  // They used to be one list. Every result went into one pool that was then
  // ranked by recency and cut to the scoring budget — and since announcements
  // and news are always fresher than an accumulated complaint thread, the
  // complaint results were collected and then buried before the model ever read
  // them. Measured on a real corpus, complaint-bearing mentions fell from 15 of
  // 60 to 3 of 48 as the recency ranking was tightened. The product is about
  // turning gripes into fixes, so that is the corpus quietly losing its point.
  // Breadth comes from distinct angles, not from more pages.
  //
  // Paging deeper mostly returns URLs the other queries already found: going
  // from three pages to six raised the raw count by about a sixth, because the
  // same thirty queries were competing for the same results. Each new query
  // shape below reaches material none of the others do — a venue nobody else
  // searched, or a subject people discuss without ever writing "review".
  const generalQueries = [
    // Where developers talk, one venue at a time. A site: query is its own
    // result space; merged into a general search it would never surface.
    `site:reddit.com ${brand}`,
    `site:news.ycombinator.com ${brand}`,
    `site:x.com ${brand}`,
    `site:stackoverflow.com ${brand}`,
    `site:dev.to ${brand}`,
    `site:medium.com ${brand}`,
    `site:lobste.rs ${brand}`,
    `site:quora.com ${brand}`,
    `site:youtube.com ${brand}`,
    `site:linkedin.com ${brand}`,
    `site:producthunt.com ${brand}`,
    `site:substack.com ${brand}`,
    `site:hashnode.dev ${brand}`,
    // AngelList's product and company discussion moved to Wellfound, and the
    // old domain still resolves — so both are asked rather than guessing which
    // one a given company is written up under.
    `site:wellfound.com ${brand}`,
    `site:angel.co ${brand}`,
    // MetaFilter is small and old and its Ask sub-site is unusually good for
    // this: long-form, first-person, and moderated hard enough that a thread is
    // people's actual experience rather than marketing.
    `site:metafilter.com ${brand}`,

    // Opinion, in the words people use when they are not writing a review.
    `"${brand}" review`,
    `"${brand}" vs`,
    `"we use ${brand}"`,
    `"tried ${brand}"`,
    `"my experience with ${brand}"`,
    `"${brand}" worth it`,
    `"${brand}" honest`,

    // Subjects that generate discussion without naming it as opinion.
    `"${brand}" pricing`,
    `"${brand}" tutorial OR guide`,
    `"${brand}" alternative`,
    `"${brand}" workflow OR setup`,
    `"${brand}" migration OR migrated`,
    `"${brand}" performance OR benchmark`,
    `"${brand}" security OR privacy`,
    `"${brand}" enterprise OR team`,
  ];

  // How people actually complain, in two registers, every line measured against
  // real results before being kept.
  //
  // The previous set was helpdesk language — "not working", "bug OR crash OR
  // error", "billing OR charged". Measured on GIMP, a product with a famously
  // hostile user opinion, `"gimp" "not working"` returned ten results of which
  // ZERO were anybody complaining, and `"gimp" bug OR crash OR error` returned
  // one. That phrasing is how a support ticket is written, not how a person
  // talks, so the complaint half of the corpus was full of documentation.
  //
  // What people actually write is a verdict or a rhetorical question — "gimp
  // sucks", "why is gimp so", "i hate gimp" — and in more measured venues, a
  // negation or a wish: "disappointed", "wish it would", "needs better". Both
  // registers are here because they occur in different places: forums and
  // Reddit are blunt, blogs and LinkedIn are polite about the same complaint.
  //
  // Hit rates measured for "gimp" (results that actually contain a gripe):
  //   "gimp sucks"                       10/10      "gimp" "not working"     0/10
  //   "hate gimp"                        10/10      "gimp" bug OR crash      1/10
  //   "why does gimp" annoying|stupid    10/10
  //   "disappointed" gimp                10/10
  //   "wish gimp" would|could|had         7/10
  //   "gimp needs" better|fixing          7/10
  //
  // Phrasings that returned nothing at all were dropped rather than kept for
  // completeness: "wouldn't recommend X", "not a fan of X", "what happened to
  // X", "X isn't for everyone" are things people say but not things they write
  // often enough to index.
  const complaintQueries = [
    // Blunt verdict.
    `"${brand} sucks"`,
    `"${brand} is trash" OR "${brand} is garbage"`,
    `"${brand} is awful" OR "${brand} is terrible"`,
    `"hate ${brand}"`,
    `"${brand} is the worst"`,

    // Rhetorical question — the most common shape a real complaint takes.
    `"why is ${brand} so"`,
    `"why does ${brand}" annoying OR stupid OR terrible`,

    // Polite register: negation, shortfall, and the wish that implies a defect.
    `"disappointed" ${brand}`,
    `"wish ${brand}" would OR could OR had`,
    `"${brand} needs" better OR fixing OR improvement`,
    `"${brand} isn't" OR "${brand} is not" recommend OR ideal OR great`,
    `"${brand} falls short" OR "${brand} lacks"`,
    `"struggled with ${brand}" OR "struggling with ${brand}"`,

    // The failure as an event, in the past tense. The highest-value shape here:
    // 10/10 for GIMP, and unlike a pure verdict it names a defect, which is
    // what triage can actually turn into a ticket.
    `"${brand} froze" OR "${brand} crashed"`,
    `"${brand} keeps freezing" OR "${brand} keeps crashing"`,

    // Euphemism and profanity, in two groups that are NOT the same complaint.
    //
    //  - "garbage", "trash", "waste of time", "dumpster fire" is a verdict on
    //    whether the thing is worth the effort. The product may work exactly as
    //    designed; the person has decided the payoff does not justify the cost.
    //    That is a usability or feature-gap finding, and no bug fix addresses it.
    //
    //  - "bullshit", "bs", "crap" is a verdict on whether it can be trusted to
    //    do what it says. Something behaved unpredictably, or the behaviour
    //    contradicted what was promised. That is a reliability finding, and it
    //    usually does have a defect underneath it.
    //
    // Conflating them produces tickets that cannot be actioned: "users say it
    // is garbage" is not a bug report, and "users say it is bullshit" filed as
    // a UX complaint loses the defect. Both are searched; triage is told to
    // keep them apart.
    `"${brand}" "hot garbage" OR "dumpster fire"`,
    `"${brand}" "waste of time" OR "not worth it"`,
    `"${brand}" bullshit OR bs`,
    `"${brand} is crap" OR "${brand} is crappy"`,

    // Something changed and made it worse — where regressions surface.
    `"the new ${brand}" bad OR worse OR ruined`,
    `"${brand}" "gave up" OR "giving up on"`,

    // Venue-scoped sweeps, and the one place defects are filed as defects.
    `site:reddit.com "${brand}" sucks OR terrible OR frustrating OR annoying`,
    `site:news.ycombinator.com "${brand}" bad OR broken OR frustrating`,
    `site:github.com "${brand}" issue bug`,
  ];

  const queries = [...generalQueries, ...complaintQueries];

  // A subreddit or GitHub org we already found is a sharper query than a blind
  // name search, so fold the real ones in.
  for (const profile of profiles.filter((candidate) => candidate.official)) {
    if (profile.platform === 'reddit' && profile.handle.startsWith('r/')) {
      queries.push(`site:reddit.com/${profile.handle} ${brand}`);
    }
    if (profile.platform === 'github') queries.push(`site:github.com/${profile.handle} issues`);
  }

  // A widening recent sweep, then a small unrestricted pass for the handful of
  // genuinely historical questions.
  //
  // An unrestricted sweep alone is what made this stage useless on a big
  // company. Search ranks by relevance, and for a product with years of
  // coverage the most "relevant" pages are old, heavily-linked ones — so it
  // came back led by an eighteen-month-old thread, and because the corpus is
  // then cut to sixty, the last week of discussion could fail to make it in at
  // all.
  const onError = (query: string, message: string) => emit('warn', `search "${query}" failed — ${message}`);

  const dig = digging();

  // Digging into one venue.
  //
  // Two shapes, because the venues are two kinds of thing. Reddit, Hacker News
  // and GitHub have readers of their own whose limits get lifted above. Every
  // other venue arrives through general web search, where "search it harder"
  // means aiming queries at the sites that make up that venue and taking them
  // unwindowed — which is a real lever, and leaving those rows unclickable was
  // an artefact of how the code was organised rather than an answer.
  if (dig) {
    const hosts = venueHosts(dig, profiles);
    if (hosts.length) {
      const aimed = hosts.flatMap((host) => [
        `site:${host} ${brand}`,
        `site:${host} ${brand} problem OR broken OR "doesn't work"`,
      ]);
      complaintQueries.push(...aimed);
      emit('info', `digging into ${dig} — ${aimed.length} queries across ${hosts.join(', ')}`);
    } else {
      emit('info', `digging into ${dig} — its own limits lifted for this run`);
    }
  }

  // Other languages, when the scan asks for them.
  //
  // These go in with the complaint queries rather than the general ones,
  // because they are complaint queries — the brand plus 崩溃, plus the venues
  // where that argument happens. That also puts them in the unwindowed pass,
  // which is right for the same reason it is right in English: a complaint
  // does not stop being true because it was written last year.

  const packs = enabledLanguages(runLanguages());
  if (packs.length) {
    const foreign = [...new Set(packs.flatMap((pack) => queriesFor(pack, brand, isDeep())))];
    complaintQueries.push(...foreign);
    emit('info', `also searching in ${packs.map((p) => p.label).join(', ')} — ${foreign.length} more queries`);
  }

  emit('info', `${generalQueries.length} general + ${complaintQueries.length} complaint searches`);

  // The general pass chases recency: what is being said right now.
  const general = await searchWidening(
    generalQueries,
    {
      count: 20,
      target: deeper(DISCOVERY_TARGET),
      pages: SEARCH_PAGES,
      // A deep run walks every rung to the end rather than stopping at the
      // first one that satisfies the target. That is the whole difference:
      // "last month had enough" is exactly how the last five years stayed
      // invisible.
      exhaustive: isDeep(),
    },
    onError,
    (rung, total) => emit('info', `general: ${windowLabel(rung)} → ${total} results`),
  );

  // The complaint pass is NOT windowed, and that is the whole point of running
  // it separately.
  //
  // Complaints accumulate; they do not trend. The definitive thread on why a
  // mature product is frustrating was written years ago and is still true, and
  // still what people link. Running these through the recency ladder meant the
  // ladder hit its target inside the last month and stopped — so the highest
  // precision queries in the whole system, the ones measured at 10/10 for
  // returning real gripes, never had their actual results fetched.
  //
  // Recency is applied afterwards, as ranking, where it belongs. The general
  // pass above is what answers "what is being said right now".
  const complaintHits = await braveSearchAll(complaintQueries, 20, onError, undefined, SEARCH_PAGES);
  const complaint = { hits: complaintHits, window: undefined, steps: [] };

  emit(
    'info',
    `general settled on ${windowLabel(general.window)} (${general.hits.length} results), `
    + `complaint sweep unwindowed (${complaint.hits.length} results)`,
  );

  // One unrestricted pass for the questions that are genuinely historical —
  // "switched from X", "X vs Y" — whose best answers accumulated over years and
  // would be thrown away by any window.
  const all = await braveSearchAll(HISTORICAL_QUERIES(brand), 20, onError, undefined, SEARCH_PAGES);

  // What the text says, not which query found it. The complaint pass casts a
  // wide net — Brave's OR is a preference, not a filter — so "came back from a
  // complaint query" marked almost the whole corpus and ranked nothing.
  const fromComplaints = new Set(
    [...complaint.hits, ...general.hits, ...all].filter(looksLikeComplaint).map((hit) => hit.url),
  );

  const merged = new Map<string, SearchHit>();
  for (const hit of [...complaint.hits, ...general.hits, ...all]) {
    if (!merged.has(hit.url)) merged.set(hit.url, hit);
  }
  const hits = [...merged.values()];
  emit('info', `${hits.length} distinct results, ${fromComplaints.size} whose text reads as a complaint`);

  const ownHost = (() => {
    try {
      return new URL(site).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  })();

  // Counted per reason rather than in total. A single "dropped 79 results"
  // line — worse, one that called all of them dictionary noise — hides which
  // filter is eating the corpus, and with a subject like "gimp", which is an
  // ordinary English word, that is exactly the thing you need to see.
  const reasons = { ownSite: 0, lexical: 0, unrelated: 0, homepage: 0 };
  const usable = hits.filter((hit) => {
    // A vendor's own blog, docs and status page are not third-party discussion.
    if (ownHost && hit.url.includes(ownHost)) { reasons.ownSite += 1; return false; }
    // A brand that is also an ordinary word drags in dictionary and spelling
    // pages, which carry no opinion to score and no complaint to triage.
    if (isLexicalNoise(hit)) { reasons.lexical += 1; return false; }
    // Must actually be about the company, and not a site's front page — both of
    // which a narrow freshness window otherwise lets straight through.
    // Kept strict on purpose. Exempting complaint-shaped posts from discussion
    // venues was tried and let in gripes about MMA, Slipknot and golf games —
    // complaint language is common enough that without the brand test it
    // matches the whole of Reddit.
    if (!namesCompany(hit, brand)) { reasons.unrelated += 1; return false; }
    // A different thing that happens to share the name.
    if (isWrongSubject(hit, exclude)) { reasons.unrelated += 1; return false; }
    if (isHomepage(hit.url)) { reasons.homepage += 1; return false; }
    return true;
  });

  const dropped = hits.length - usable.length;
  if (dropped) {
    emit(
      'info',
      `kept ${usable.length} of ${hits.length}: dropped ${reasons.ownSite} on ${ownHost || 'own site'}, `
      + `${reasons.lexical} dictionary/spelling, ${reasons.unrelated} that never name "${brand}", `
      + `${reasons.homepage} homepages`,
    );
  }

  // Real discussion ahead of SEO roundups, and recent ahead of old, so the 60
  // we keep are the 60 worth reading rather than whatever search ranked highest.
  //
  // Undated hits sit between recent and old rather than at the bottom. A page
  // search could not date is more often a forum thread or a comment than a
  // dead article, and burying it under material we know to be two years old
  // would be a worse guess than the one made here.
  // Interleave rather than sort into one list.
  //
  // Both groups are ranked the same way internally, then taken in turns, so the
  // head of the corpus — the part the model can afford to read — is about half
  // complaints by construction. A single sorted pool cannot do this: whatever
  // the sort key is, one kind of result wins the top and the other is cut.
  const complaintsFirst = usable.filter((hit) => fromComplaints.has(hit.url)).sort(rankByDiscussionThenRecency);
  const rest = usable.filter((hit) => !fromComplaints.has(hit.url)).sort(rankByDiscussionThenRecency);

  const ordered: SearchHit[] = [];
  for (let i = 0; i < Math.max(complaintsFirst.length, rest.length); i += 1) {
    if (i < complaintsFirst.length) ordered.push(complaintsFirst[i]!);
    if (i < rest.length) ordered.push(rest[i]!);
  }

  const fresh = ordered.filter((hit) => hit.date && isRecent(hit.date)).length;
  emit(
    'info',
    `${ordered.filter(isOpinionBearing).length} of ${ordered.length} look like real discussion, `
    + `${fresh} from the last ${RECENT_MONTHS} months`,
  );

  // Everything above came through a web search engine, which is a real ceiling
  // rather than a tuning problem: the corpus is whatever a general-purpose
  // ranker decided to surface for a `site:` query, and no amount of query
  // craft gets past what it chose to index and rank. Several of these venues
  // publish their own corpus and will answer directly, exactly, and for free.
  // Asked directly, Hacker News has eleven thousand comments about GIMP; asked
  // through a search engine, it had a couple of dozen links.
  //
  // All four run at once. They are independent HTTP calls against four
  // different hosts, and running them in series added most of a minute to the
  // stage for no reason. A source that fails resolves to an empty list rather
  // than taking the stage down with it.
  const [upstream, hn, ghIssues, appReviews, reddit] = await Promise.all([
    // The project's own tracker. These are defects somebody already wrote up
    // properly, with versions and steps. They go in as mentions rather than as
    // ready-made issues so triage sees both halves at once and can merge them:
    // four people grumbling about a crash plus the filed bug describing it is
    // one issue with five pieces of evidence, and knowing a ticket already
    // exists changes what to do about it.
    upstreamMentions(company, site, emit, subject),
    // Algolia pages at 1,000 and charges nothing, so this is two requests for
    // everything HN has said in a year. The classifier downstream is a regex,
    // so a wider pool costs seconds of fetching and no judgement at all.
    // Deepened one source at a time, when the coverage grid asked.
    //
    // The gaps that grid shows are per-source and have different causes: Hacker
    // News is bounded by a 365-day window, GitHub by taking only the newest
    // forty issues — which on an active project is a couple of months, and is
    // why its row crams into the last two columns with nothing behind it. Both
    // limits are right for a nightly run and wrong the moment somebody points
    // at the hole and asks for the history.
    searchHackerNews(brand, emit, dig === 'hackernews'
      ? { days: null, limit: 3_000 }
      : { days: 365 }).catch(() => []),
    searchGithubIssues(brand, emit, dig === 'github'
      ? { ownRepo: ownRepoOf(subject), limit: 400 }
      : { ownRepo: ownRepoOf(subject), limit: 40 }).catch(() => []),
    findAppReviews(brand, site, emit, 60).catch(() => []),
    // Reddit through its own API rather than through `site:reddit.com`. Null
    // when there are no credentials, which is not an error — the search path
    // still covers reddit.com, just less deeply.
    searchReddit([brand], emit, {
      // A listing request returns up to 100 whether you ask for 25 or 100, so
      // this is four times the corpus for the same rate-limit cost.
      perAlias: 100,
      exclude,
      site,
      // The footprint stage already searched for this product's communities.
      // Handing them over is what stops the subreddit probe guessing at a name
      // when the right one has been sitting in `profiles` all along.
      discovered: profiles.filter((p) => p.platform === 'reddit').map((p) => p.handle),
    }).then((found) => found ?? []).catch(() => []),
  ]);

  const searched = ordered.map((hit) => ({
      // Derived from the URL, never minted. An issue cites its evidence by
      // mention id, so a random one made every citation good only until the
      // next discovery run — and "search this source harder" IS a discovery
      // run, so using that feature blanked the Source panel on every defect
      // already triaged.
      id: mentionId(hit.url),
      venue: venueOf(hit.url),
      title: hit.title,
      url: hit.url,
      date: hit.date,
      author: null,
      excerpt: hit.description,
      engagement: null,
      // Sentiment is the model's job, in the buzz stage, over this fetched
      // text. Search does not guess at it.
      sentiment: 'neutral' as const,
      score: 0,
      themes: [],
      discussion: isOpinionBearing(hit),
      complaint: fromComplaints.has(hit.url),
  }));

  // Interleaved, not concatenated, and each source guaranteed a share.
  //
  // GIMP's tracker alone returned 46 open issues, which put in front would have
  // taken 46 of the 60 slots the model can afford to read and left fourteen for
  // everything the public said. Filed bugs are the easy half — already written
  // up, already triaged by whoever filed them — and the product exists for the
  // half that is not.
  //
  // The same argument now applies four ways, so the pools are round-robined
  // rather than ranked against each other. Ranking them together would be
  // ranking incomparable things: an app-store review is always fresher than an
  // accumulated forum thread, a filed issue always reads as more concrete than
  // somebody's aside, and whichever axis is chosen, one whole source
  // disappears below the cut. Round-robin means no source can be starved by
  // another being louder.
  const filed = [...upstream, ...ghIssues];
  // Content from a product's own subreddit is on-topic by construction.
  //
  // Everything in r/GIMP is about GIMP whether or not the word appears in it —
  // "it crashes when I export" needs no brand name to be a GIMP bug report, and
  // a site-wide sweep for "gimp" returns motorbikes. That is a real difference
  // in what a mention is worth, so it ranks: the topic question is already
  // answered and only the fault question remains.
  const voices = [...hn, ...appReviews, ...reddit]
    // Complaint-shaped first within this pool: these arrive unranked, straight
    // from a date-sorted index, so nothing else has already surfaced the ones
    // that matter. Then the community's own, for the reason above.
    .sort((a, b) =>
      Number(Boolean(b.complaint)) - Number(Boolean(a.complaint))
      || Number(fromOwnCommunity(b)) - Number(fromOwnCommunity(a)));

  const corpus: Mention[] = [];
  const seenUrls = new Set<string>();
  const take = (mention: Mention | undefined) => {
    if (!mention || seenUrls.has(mention.url)) return;
    seenUrls.add(mention.url);
    corpus.push(mention);
  };
  for (let i = 0; i < Math.max(filed.length, voices.length, Math.ceil(searched.length / 2)); i += 1) {
    take(filed[i]);
    take(voices[i]);
    take(searched[i * 2]);
    take(searched[i * 2 + 1]);
  }

  // Disambiguation first, complaint triage second. Both are paid model time,
  // and there is no sense reading an item for what is wrong with it before
  // establishing that it is about this product at all — a well-written
  // complaint about a different Bolt would sail through triage.
  const onTopic = await dropWrongSubject(company, site, corpus, emit, subject);

  // Before the cut, because the flag is what decides who survives it.
  await triageUnflagged(company, onTopic, emit);

  const head = onTopic.slice(0, SCORE_BUDGET);
  const share = (pool: Mention[]) => head.filter((m) => pool.includes(m)).length;
  emit(
    'info',
    `the model will read ${head.filter((m) => m.complaint).length}/${head.length} complaint-bearing `
    + `— ${share(filed)} filed issues, ${share(voices)} first-person posts and reviews, `
    + `${share(searched)} from search`,
  );

  return onTopic.slice(0, deeper(MENTION_CAP));
}

/* ------------------------------------------------------------------- feed */

/** Pull the latest things to surface about a company — new videos, comments and
 *  posts, newest first — by running the attached search connectors (YouTube
 *  search first). */
const FEED_QUALITY_BATCH = 20;

/** Drop the items nobody said anything in.
 *
 *  The feed was the only stage with no judgement in it — search, a URL filter,
 *  then the screen — and what that produced on a real run was a page of
 *  furniture: X's sign-in wall, a subreddit's standing welcome message five
 *  times over, and a footer of Terms/Privacy/Cookies links. Every one of them
 *  is recent, names the company and is not a homepage, so no test a URL can
 *  answer would ever catch them. Only reading them settles it, which is what
 *  the model is for.
 *
 *  Never throws, and on failure keeps everything: a feed with some chrome in it
 *  is worse than a clean one and far better than an empty one.
 */
async function keepDatapoints(company: string, items: FeedItem[], emit: Emit): Promise<FeedItem[]> {
  if (items.length === 0) return items;

  const dropped = new Set<FeedItem>();
  let read = 0;
  let unquoted = 0;

  for (let start = 0; start < items.length; start += FEED_QUALITY_BATCH) {
    const batch = items.slice(start, start + FEED_QUALITY_BATCH);
    try {
      const result = await runAgent<{ verdict: { index: number; quote?: string; isDatapoint: boolean }[] }>(
        feedQualityAgent,
        {
          prompt: `Product: "${company}".\n\n`
            + batch.map((item, index) =>
              `${index}: ${item.headline}\n${(item.snippet ?? '').slice(0, 500).replace(/\s+/g, ' ')}`).join('\n\n'),
          items: batch.length,
          note: `feed ${start + 1}–${start + batch.length}`,
          timeoutMs: 180_000,
        },
      );
      read += batch.length;

      for (const verdict of result.verdict ?? []) {
        const item = batch[verdict.index];
        if (!item) continue;
        if (verdict.isDatapoint) {
          // The quote has to be real. Without checking it, "quote first" buys
          // nothing — it is a field the model can fill with anything.
          if (!quotesTheSource(verdict.quote, `${item.headline} ${item.snippet ?? ''}`)) {
            unquoted += 1;
          }
          continue;
        }
        dropped.add(item);
      }
    } catch (error) {
      emit('warn', `feed triage batch failed — ${describeError(error).slice(0, 100)}`);
    }
  }

  if (dropped.size === 0) {
    emit('info', `feed: read ${read} items, none of them were page furniture`);
    return items;
  }
  emit(
    'info',
    `feed: dropped ${dropped.size} of ${read} — sign-in walls, sidebars and navigation that name the product`
    + (unquoted ? `, and ${unquoted} kept whose quote was not in the text` : ''),
  );
  return items.filter((item) => !dropped.has(item));
}

/** How many items the feed wants before it stops widening its window. */
const FEED_TARGET = Number(process.env.FEED_TARGET ?? 120);
const FEED_CAP = Number(process.env.FEED_CAP ?? 200);

export async function findFeed(
  company: string, site: string, profiles: Profile[], emit: Emit, subject?: Subject,
): Promise<FeedItem[]> {
  // The feed is the same deterministic search, biased to fresh things and
  // sorted newest first. YouTube gets its own queries because video is the
  // feed's primary source.
  // Every one of these quotes the company name. Unquoted, `${company} news`
  // matched the word "news" against every news site's front page — which is
  // recrawled hourly and therefore always the freshest thing in any window.
  const { brand, exclude } = searchIdentity(company, site, subject);

  const queries = [
    `"${brand}" news`,
    `"${brand}" announcement OR launch OR update`,
    `site:youtube.com "${brand}"`,
    `site:reddit.com "${brand}"`,
    `site:news.ycombinator.com "${brand}"`,
    `site:x.com "${brand}"`,
  ];

  for (const profile of profiles.filter((candidate) => candidate.official)) {
    if (profile.platform === 'youtube') queries.push(`site:youtube.com ${profile.handle} ${brand}`);
    if (profile.platform === 'reddit' && profile.handle.startsWith('r/')) {
      queries.push(`site:reddit.com/${profile.handle}`);
    }
  }

  // Starts at the last 24 hours and widens only if that is not enough. The
  // comment above used to say this stage was "biased to fresh things" while
  // passing no freshness at all, which is how a feed for a company posting
  // hourly came back led by something three weeks old.
  emit('info', `feed: ${queries.length} searches, starting at the last 24 hours`);
  const { hits, window, steps } = await searchWidening(
    queries,
    { count: 20, target: FEED_TARGET, pages: SEARCH_PAGES },
    (query, message) => emit('warn', `search "${query}" failed — ${message}`),
    (rung, total) => emit('info', `feed: ${windowLabel(rung)} → ${total} results`),
  );
  emit(
    'info',
    `feed: settled on ${windowLabel(window)} after ${steps.length} `
    + `window${steps.length === 1 ? '' : 's'}, ${hits.length} results`,
  );

  // Fresh is not the same as relevant, and a tight window makes that gap wide:
  // anything recrawled constantly looks new. Require the company to actually be
  // named, and drop bare homepages, before anything is called a feed item.
  //
  // Two more exclusions specific to a feed:
  //
  //  - Reference pages. A Wikipedia article that mentions the company carries an
  //    edit timestamp, so it arrives looking hours old, and it is nobody saying
  //    anything — it is an encyclopedia entry that happens to have been touched.
  //  - The company's own site. Their marketing pages are not news about them.
  //    Their own *social accounts* stay: an announcement on their X account is a
  //    real event in the feed, and it lives on x.com, not on their domain.
  const feedHost = (() => {
    try {
      return new URL(site).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  })();

  const relevant = hits.filter((hit) =>
    namesCompany(hit, brand)
    && !isHomepage(hit.url)
    && !/wikipedia\.org|wikimedia\.org|fandom\.com/.test(hit.url)
    && !isWrongSubject(hit, exclude)
    && (!feedHost || !hit.url.includes(feedHost)));
  const irrelevant = hits.length - relevant.length;
  if (irrelevant) emit('info', `feed: dropped ${irrelevant} result(s) that never name ${brand}`);

  const kindOf = (url: string): FeedItem['kind'] => {
    if (/youtube\.com\/watch|youtu\.be\//.test(url)) return 'video';
    if (/\/comments\/.+\/.+\/.+/.test(url)) return 'comment';
    return 'post';
  };

  const items = relevant.map((hit) => ({
    id: mentionId(hit.url),
    venue: venueOf(hit.url),
    kind: kindOf(hit.url),
    headline: hit.title,
    url: hit.url,
    date: hit.date,
    author: null,
    snippet: hit.description,
    engagement: null,
  })) as FeedItem[];

  emit('info', `feed: ${items.length} items, ${items.filter((item) => item.date).length} dated`);

  const worthShowing = await keepDatapoints(company, items, emit);

  // Dated items first, newest to oldest; undated ones keep search order behind
  // them rather than being dropped.
  return worthShowing
    .sort((a, b) => {
      if (a.date && b.date) return b.date.localeCompare(a.date);
      if (a.date) return -1;
      if (b.date) return 1;
      return 0;
    })
    .slice(0, FEED_CAP);
}

function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  // A date in the future is a hallucination, not news.
  if (parsed.getTime() > Date.now() + 86_400_000) return null;
  return parsed.toISOString();
}

/* -------------------------------------------------------------------- buzz */

/** How many mentions the model is asked to score.
 *
 *  This is a budget, not a corpus size, and keeping the two separate is the
 *  point. Retrieval can now collect hundreds of rows for the price of a few
 *  minutes of paging; scoring is minutes per few dozen on a local model, and
 *  scoring three hundred would take hours. So everything found is kept and
 *  shown, and the model reads the top slice of it — which, because the corpus
 *  is ranked real-discussion-first then newest-first, is the part worth
 *  reading anyway.
 *
 *  Raise it when pointing at a fast hosted model, where the arithmetic is
 *  completely different. */
/** How many mentions the model reads and scores.
 *
 *  Was 60, chosen when a batch held four items and 60 meant fifteen sequential
 *  model calls. Batches are packed by size now, and a corpus of Reddit comments
 *  packs at ten to fourteen — so the same wall-clock buys far more reading. The
 *  pool it selects from has also grown by an order of magnitude: HN alone
 *  returns 965 items about GIMP in a year, and a scan sees a couple of thousand.
 *  Reading 4% of that and calling it the sentiment was the real cap. */
const SCORE_BUDGET = Number(process.env.SCORE_BUDGET ?? 180);

export async function scoreBuzz(
  company: string, mentions: Mention[], emit: Emit,
): Promise<{ mentions: Mention[]; verdict: string }> {
  if (mentions.length === 0) return { mentions, verdict: 'No third-party discussion found to score.' };

  // The corpus keeps its order; only the head of it is scored. The unscored
  // tail stays in the mention list and stays visible in Discovery — it is real
  // discussion that was found, and hiding it would misrepresent the reach of
  // the search as the reach of the model.
  const budgeted = mentions.slice(0, SCORE_BUDGET);
  if (mentions.length > budgeted.length) {
    emit(
      'info',
      `scoring the top ${budgeted.length} of ${mentions.length} mentions — the rest are collected `
      + `and listed but not scored (SCORE_BUDGET)`,
    );
  }

  // Score in batches rather than in one turn.
  //
  // A single turn over 60 mentions has to emit 60 scored objects before it
  // returns anything, which on a local model means thousands of output tokens
  // against a 4k cap and several minutes of silence — and if it trips at token
  // 3,900 the whole stage is lost. Batches keep each turn inside the model's
  // context and output limits, let a bad batch fail on its own without taking
  // the other five with it, and report progress as they land.
  // Packed by size, with a measured item ceiling.
  //
  // This was a fixed four per batch because eight and twelve overflowed the
  // reply. That was real, but the cause was not the batch size — it was that
  // every scored item had to carry its URL back: ninety characters of Reddit
  // permalink per item, in the prompt AND in the answer, none of which is
  // needed to judge a sentiment. Keyed by index instead (see buzzSchema) the
  // same model on the same corpus handles far more:
  //
  //      4 items  3/3 ok   8s        24 items  2/2 ok  20s
  //      8 items  3/3 ok  11s        32 items  2/2 ok  29s
  //     16 items  3/3 ok  14s        48 items  0/2 ok  — all failed
  //
  // 24 is that measurement with a margin under the 32 that still worked. The
  // character budget is the second limit, for long fetched articles where two
  // dozen would be a novel; short comments pack to the item ceiling instead.
  const BATCH_CHARS = 12_000;
  const MAX_BATCH_ITEMS = 24;

  /** Characters of page text per item. Real thread text is far longer than a
   *  search snippet and has to be trimmed to leave output budget. */
  const TEXT_BUDGET = 900;

  const sizeOf = (m: Mention) => Math.min(m.excerpt.length, TEXT_BUDGET) + m.title.length + 40;

  const batches: Mention[][] = [];
  {
    let current: Mention[] = [];
    let chars = 0;
    for (const mention of budgeted) {
      const size = sizeOf(mention);
      if (current.length && (chars + size > BATCH_CHARS || current.length >= MAX_BATCH_ITEMS)) {
        batches.push(current);
        current = [];
        chars = 0;
      }
      current.push(mention);
      chars += size;
    }
    if (current.length) batches.push(current);
  }

  // Fetch what people actually wrote before scoring any of it. Without this the
  // model is rating Brave's meta description — SEO copy, not opinion. Only the
  // budgeted head is fetched: fetching pages nobody will read is the same waste
  // as scoring them.
  emit('info', `fetching real page text for ${budgeted.length} mentions`);
  const fetched = await fetchAll(budgeted, (done, total, full) =>
    emit('info', `fetched ${done}/${total} (${full} with full text)`));
  const fullCount = [...fetched.values()].filter((f) => f.full).length;
  emit('info', `${fullCount}/${budgeted.length} yielded real content; the rest keep their search snippet`);

  emit(
    'info',
    `scoring ${budgeted.length} mentions in ${batches.length} batches `
    + `(${Math.round(budgeted.length / Math.max(1, batches.length))} per batch on average)`,
  );

  const scores = new Map<string, { sentiment: Mention['sentiment']; score: number; themes?: string[] }>();
  const verdicts: string[] = [];

  for (const [index, batch] of batches.entries()) {
    const corpus = batch.map((m, i) => {
      const got = fetched.get(m.url);
      return {
        // The URL is not sent either. Scoring sentiment needs the words, not
        // the address they live at, and leaving it out saves as much input as
        // the index saves output.
        index: i,
        venue: m.venue,
        date: m.date,
        title: m.title,
        // Real thread text where it could be fetched, the snippet otherwise —
        // flagged, so the model knows when it is judging a summary rather than
        // someone's actual words.
        text: (got?.text ?? m.excerpt).slice(0, TEXT_BUDGET),
        isFullText: got?.full ?? false,
      };
    });

    try {
      // Straight to the model endpoint with the schema attached — see
      // app/server/model.ts for why this does not go through a saved agent.
      const { scored, verdict } = await runAgent<{
        scored: { index: number; sentiment: Mention['sentiment']; score: number; themes?: string[] }[];
        verdict: string;
      }>(buzzAgent, {
        prompt: `Product: "${company}". Score every item and write the verdict.\n\n${JSON.stringify(corpus)}`,
        note: `batch ${index + 1}/${batches.length}`,
        items: corpus.length,
      });

      // A model that ignores the -1..1 range (local ones return 0-10 often
      // enough) would otherwise clamp to +1 and read as unanimous delight.
      // Flag it rather than quietly recording the wrong sentiment.
      const outOfRange = (scored ?? []).filter((entry) => Math.abs(Number(entry?.score) || 0) > 1).length;
      if (outOfRange) {
        emit('warn', `batch ${index + 1}: ${outOfRange} score(s) outside -1..1 — clamped, treat this batch's numbers as rough`);
      }

      for (const entry of scored ?? []) {
        // An index outside the batch is a model error with no safe repair —
        // there is no way to tell which item was meant, and attaching a score
        // to the wrong mention is worse than leaving one unscored.
        const mention = batch[entry?.index ?? -1];
        if (mention) scores.set(mention.url, entry);
      }
      if (verdict) verdicts.push(verdict);
      emit('info', `batch ${index + 1}/${batches.length}: ${(scored ?? []).length} scored`);
    } catch (error) {
      // One failed batch leaves those mentions unscored (neutral); it does not
      // cost the batches that worked.
      emit('warn', `batch ${index + 1}/${batches.length} failed — ${error instanceof Error ? error.message.slice(0, 120) : 'error'}`);
    }
  }

  if (scores.size === 0) throw new Error('every buzz batch failed — nothing could be scored');

  emit('info', `${scores.size}/${mentions.length} mentions scored`);

  const scored = mentions.map((m) => {
    const hit = scores.get(m.url);
    if (!hit) return m;
    return {
      ...m,
      sentiment: hit.sentiment ?? 'neutral',
      score: clamp(hit.score ?? 0),
      themes: hit.themes ?? [],
      scored: true,
    };
  });

  // One verdict written over the whole corpus, not fifteen batch verdicts glued
  // end to end.
  //
  // Concatenating them produced a paragraph that argued with itself — "drifting
  // negative, and the pull is growing steeper" immediately followed by
  // "flat-to-slightly-positive" — because each batch only ever saw four items
  // and generalised from them. A verdict is a claim about the whole window, so
  // it has to be written somewhere that can see the whole window. This call is
  // cheap: it reasons over the tallies and a sample, not the full corpus.
  const verdict = await summariseVerdict(company, scored, emit)
    // Falling back to the first batch verdict is worse than the real thing but
    // better than nothing, and much better than the contradictory join.
    .catch(() => verdicts[0] ?? '');

  return { mentions: scored, verdict };
}

/** Write the one-paragraph verdict over the finished corpus. */
async function summariseVerdict(company: string, mentions: Mention[], emit: Emit): Promise<string> {
  const tally = { positive: 0, negative: 0, neutral: 0, mixed: 0 } as Record<string, number>;
  const themes = new Map<string, number>();
  for (const m of mentions) {
    tally[m.sentiment] = (tally[m.sentiment] ?? 0) + 1;
    for (const theme of m.themes ?? []) themes.set(theme, (themes.get(theme) ?? 0) + 1);
  }

  // The extremes carry the argument; the middle rarely says anything sharp.
  const ranked = [...mentions].sort((a, b) => a.score - b.score);
  const sample = [...ranked.slice(0, 8), ...ranked.slice(-8)].map((m) => ({
    date: m.date, score: m.score, title: m.title, excerpt: m.excerpt.slice(0, 200),
  }));

  const top = [...themes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

  emit('info', 'writing the verdict over the whole window');
  const { verdict } = await runAgent<{ verdict: string }>(verdictAgent, {
    prompt: `Product: "${company}". Write ONLY the one-paragraph verdict for the whole window — `
      + `which way perception is moving and what is driving it. Do not score anything.\n\n`
      + `Totals across ${mentions.length} mentions: ${JSON.stringify(tally)}\n`
      + `Most common themes: ${JSON.stringify(top)}\n\n`
      + `The most negative and most positive items:\n${JSON.stringify(sample)}`,
    items: mentions.length,
  });
  return verdict ?? '';
}

const clamp = (n: number) => Math.max(-1, Math.min(1, Number(n) || 0));

/* ------------------------------------------------------------------ health */

export async function findIssues(
  company: string, mentions: Mention[], emit: Emit,
): Promise<Issue[]> {
  // Worst-first, and capped: triage has to emit a full issue object (summary,
  // impact, evidence, a draft reply) per issue, which is far more output per
  // input than scoring is. Handing it every complaint at once overruns the
  // model's output cap and loses the entire stage, so take the most negative
  // ones — those are the issues worth filing anyway.
  const MAX_COMPLAINTS = 20;

  // Triage selects the worst-scored mentions, so it is only meaningful once
  // something has scored them. When buzz fails, every mention still carries its
  // initial score of 0, they all pass the filter, and the "worst 20" is an
  // arbitrary 20 — which then produced a confident "no defects found". Refuse
  // instead: a stage that cannot do its job has to say so, not return nothing.
  const scored = mentions.filter((m) => m.score !== 0 || m.sentiment !== 'neutral');
  if (mentions.length > 0 && scored.length === 0) {
    throw new Error(
      'triage needs scored mentions and none are scored — the sentiment stage did not run or failed, '
      + 'so there is nothing to rank complaints by',
    );
  }

  const complaints = mentions
    .filter((m) => m.score < 0.15)
    .sort((a, b) => a.score - b.score)
    .slice(0, MAX_COMPLAINTS);
  if (complaints.length === 0) return [];

  // Same treatment as scoring: triage the real complaint text, not a snippet.
  // These pages are almost all already in the content cache from the buzz
  // stage, so this is close to free.
  emit('info', `fetching complaint text for ${complaints.length} mentions`);
  const fetched = await fetchAll(complaints, (done, total, full) =>
    emit('info', `fetched ${done}/${total} (${full} with full text)`));

  const corpus = complaints.map((m) => {
    const got = fetched.get(m.url);
    return {
      id: m.id,
      url: m.url,
      date: m.date,
      venue: m.venue,
      title: m.title,
      text: (got?.text ?? m.excerpt).slice(0, 900),
      isFullText: got?.full ?? false,
    };
  });

  // Batched, for the same reason buzz is: one issue object carries a summary,
  // an impact statement, an evidence list and a draft reply, so a triage turn
  // over twenty complaints has to emit far more text than a scoring turn does.
  // Unbatched it ran past the request timeout and the whole stage was lost.
  //
  // The cost is real and worth stating: merging duplicates ("one issue per
  // underlying cause") can only happen inside a batch, so the same complaint
  // raised in two different batches can surface twice.
  const BATCH = 3;
  const batches: typeof corpus[] = [];
  for (let i = 0; i < corpus.length; i += BATCH) batches.push(corpus.slice(i, i + BATCH));

  emit('info', `triaging ${complaints.length} complaints in ${batches.length} batches`);

  const issues: Omit<Issue, 'id' | 'status' | 'firstSeen' | 'lastSeen'>[] = [];
  const failures: string[] = [];
  let succeeded = 0;
  /** Issues that cited something outside their batch. Counted rather than
   *  hidden: an issue whose sources cannot be opened is exactly the one a
   *  reader needs warning about. */
  let unresolved = 0;
  for (const [index, batch] of batches.entries()) {
    try {
      const result = await runAgent<{
        issues: (Omit<Issue, 'id' | 'status' | 'firstSeen' | 'lastSeen' | 'evidence'> & { evidence: number[] })[];
      }>(healthAgent, {
        // Numbered, and the id withheld. The model is given an index to cite
        // and nothing that looks like one to copy — the internal id was never
        // in the prompt, and the url is now labelled rather than offered as an
        // identifier.
        prompt: `Product: "${company}". Triage these complaints.\n\n`
          + batch.map((item, i) => `${i}: ${JSON.stringify({ ...item, id: undefined })}`).join('\n'),
        note: `batch ${index + 1}/${batches.length}`,
        items: batch.length,
      });

      for (const issue of result.issues ?? []) {
        // Resolved here, inside the batch, because the indices only mean
        // anything against the items this call was given.
        const cited = (issue.evidence ?? [])
          .map((i) => batch[Number(i)]?.id)
          .filter((id): id is string => Boolean(id));
        if (cited.length !== (issue.evidence ?? []).length) unresolved += 1;
        issues.push({ ...issue, evidence: cited });
      }
      succeeded += 1;
      emit('info', `batch ${index + 1}/${batches.length}: ${(result.issues ?? []).length} issue(s)`);
    } catch (error) {
      failures.push(error instanceof Error ? error.message.slice(0, 120) : 'error');
      emit('warn', `batch ${index + 1}/${batches.length} failed — ${failures.at(-1)}`);
    }
  }

  // The bug this guards: every batch failed, the loop swallowed each error, and
  // an empty list was returned and rendered as "no defects found". A company
  // with a wall of complaints was reported as healthy because the model was
  // unreachable. Nothing succeeded means the stage failed.
  if (succeeded === 0) {
    throw new Error(
      `every triage batch failed (${batches.length}/${batches.length}) — ${failures[0] ?? 'unknown error'}`,
    );
  }
  if (failures.length) {
    emit('warn', `${failures.length}/${batches.length} triage batches failed — this list is incomplete`);
  }

  if (unresolved) {
    emit('warn', `${unresolved} issue(s) cited a source outside their batch — those citations were dropped`);
  }

  const byId = new Map(mentions.map((m) => [m.id, m]));
  const catalogued = (issues ?? []).map((issue) => {
    const dates = (issue.evidence ?? [])
      .map((id) => byId.get(id)?.date)
      .filter((d): d is string => Boolean(d))
      .sort();
    return {
      ...issue,
      id: randomUUID().slice(0, 8),
      firstSeen: dates[0] ?? null,
      lastSeen: dates.at(-1) ?? null,
      status: 'open' as const,
    };
  });

  // Who raised each one, and how to answer them.
  //
  // Done here rather than on demand because it is the thing the whole pipeline
  // is for, and leaving it until somebody opens an issue means the outbox is
  // full of replies addressed to nobody. Cheap: one GitHub profile lookup for
  // the issues whose reporter posted there, nothing at all for the rest.
  const withReporters = await Promise.all(catalogued.map(async (issue) => {
    const reporter = await resolveReporter(issue, mentions).catch(() => undefined);
    return reporter ? { ...issue, reporter } : issue;
  }));

  const reachable = withReporters.filter((issue) => issue.reporter && issue.reporter.channel !== 'none').length;
  const named = withReporters.filter((issue) => issue.reporter).length;
  emit(
    'info',
    `reporters: ${named}/${withReporters.length} issues have a named reporter, ${reachable} reachable`,
  );

  return withReporters;
}

/* ------------------------------------------------------------------- abuse */

export async function findAbuse(
  company: string, site: string, mentions: Mention[], emit: Emit, subject?: Subject,
): Promise<AbuseFinding[]> {
  // Same split as the rest of the pipeline: deterministic code goes and finds
  // the candidate pages, then the model is asked once to judge which of them
  // are actually brand abuse. Handing an agent a search tool and asking it to
  // hunt could not produce valid JSON here, and the hunting part is a fixed set
  // of queries anyway — these are the surfaces abuse shows up on.
  const { brand } = searchIdentity(company, site, subject);
  const queries = [
    `"${brand}" scam`,
    `"${brand}" phishing`,
    `"${brand}" fake support`,
    `"${brand}" giveaway airdrop`,
    `"${company}" impersonating OR impersonation`,
    `"${company}" crack OR nulled OR cracked`,
    `site:npmjs.com ${company}`,
    `site:t.me ${company}`,
  ];

  emit('info', `integrity sweep: ${queries.length} searches`);
  const hits = await braveSearchAll(queries, 8, (query, message) =>
    emit('warn', `search "${query}" failed — ${message}`));

  const ownHost = (() => {
    try {
      return new URL(site).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  })();

  // The company's own pages are not abusing the company.
  const shortlist = hits
    .filter((hit) => !ownHost || !hit.url.includes(ownHost))
    .slice(0, 30);

  if (shortlist.length === 0) {
    emit('info', 'integrity sweep found nothing to judge');
    return [];
  }

  // Read the pages.
  //
  // This stage calls things phishing, impersonation and malware, and it was
  // making those calls from three hundred characters of search description —
  // which is the one thing a scam page controls completely. A fake support site
  // writes a description that reads like the real product's; the giveaway is on
  // the page. Judging the summary rather than the document is how this panel
  // would eventually accuse somebody wrongly.
  const pages = await fetchAll(
    shortlist.map((hit) => ({ url: hit.url, title: hit.title, excerpt: hit.description } as Mention)),
    (done, total, full) => emit('info', `integrity: fetched ${done}/${total} (${full} with full text)`),
  );

  const candidates = shortlist.map((hit) => ({
    url: hit.url,
    title: hit.title,
    excerpt: (pages.get(hit.url)?.text ?? hit.description).slice(0, 900),
  }));

  emit('info', `judging ${candidates.length} candidate pages`);

  // Batched, like buzz and health. Judging thirty candidate pages in one turn
  // is the shape that kept timing out and losing the whole stage; ten at a time
  // completes, and a batch that fails costs only its own ten.
  const BATCH = 10;
  const batches: typeof candidates[] = [];
  for (let i = 0; i < candidates.length; i += BATCH) batches.push(candidates.slice(i, i + BATCH));

  const findings: Omit<AbuseFinding, 'id' | 'status' | 'firstSeen'>[] = [];
  let abuseSucceeded = 0;
  for (const [index, batch] of batches.entries()) {
    try {
      const result = await runAgent<{ findings: Omit<AbuseFinding, 'id' | 'status' | 'firstSeen'>[] }>(abuseAgent, {
        prompt: `Company: "${company}" (${site}).

These pages came back from searches for misuse of this brand — impersonating accounts and Discord/Telegram servers, lookalike domains, phishing pages, giveaway and airdrop scams, fake support, counterfeit or cracked distributions, and packages published under the name.

Most of them will be ordinary coverage, reviews or discussion that merely uses the words — report only the ones the evidence actually supports as abuse, and return an empty list if none do.

Candidates:
${JSON.stringify(batch)}`,
        note: `batch ${index + 1}/${batches.length}`,
        items: batch.length,
      });
      findings.push(...(result.findings ?? []));
      abuseSucceeded += 1;
      emit('info', `batch ${index + 1}/${batches.length}: ${(result.findings ?? []).length} finding(s)`);
    } catch (error) {
      emit('warn', `batch ${index + 1}/${batches.length} failed — ${error instanceof Error ? error.message.slice(0, 120) : 'error'}`);
    }
  }

  // As with triage: nothing succeeding is a failed stage, not a clean bill of
  // health. "Nothing abusing the brand turned up" is a claim, and it must not
  // be made on the strength of a model that never answered.
  if (batches.length > 0 && abuseSucceeded === 0) {
    throw new Error(`every abuse batch failed (${batches.length}/${batches.length}) — nothing could be judged`);
  }

  const byUrl = new Map(mentions.map((m) => [m.url, m]));
  return (findings ?? []).map((finding) => {
    const dates = (finding.evidence ?? [])
      .map((url) => byUrl.get(url)?.date)
      .filter((d): d is string => Boolean(d))
      .sort();
    return {
      ...finding,
      id: randomUUID().slice(0, 8),
      evidence: finding.evidence ?? [],
      locations: finding.locations ?? [],
      firstSeen: dates[0] ?? null,
      status: 'open' as const,
    };
  });
}

/* ------------------------------------------------------- derived timeseries */

/** Bucket by month. Computed here, not asked of the model — arithmetic is not
 *  something to leave to a language model. */
/** Was this mention actually judged?
 *
 *  Falls back to the old inference for scans collected before the flag existed,
 *  where an unscored item is indistinguishable from an honestly neutral one. */
export const wasScored = (m: Mention): boolean =>
  m.scored ?? (m.score !== 0 || m.sentiment !== 'neutral');

/** How finely to bucket a timeline.
 *
 *  Everything was monthly, which for a product watched over a fortnight draws
 *  one bar. The window a scan actually covers varies enormously — a busy
 *  subreddit gives a week of dense discussion, an obscure project gives two
 *  years of sparse — and a fixed grain is wrong at one end or the other.
 *
 *  Chosen from the span rather than made configurable: the right granularity is
 *  a fact about the data, not a preference, and nobody wants to set it. */
export type Grain = 'day' | 'week' | 'month';

const DAY_MS = 86_400_000;

export function grainFor(dates: string[]): Grain {
  const times = dates.map((d) => Date.parse(d)).filter(Number.isFinite).sort((a, b) => a - b);
  if (times.length === 0) return 'month';

  // The middle of the data, not its extremes.
  //
  // Corpora here are mixed: Reddit and the feed are all from the last few days,
  // while a project's own tracker reaches back years — GIMP's spans two
  // decades. Measuring end to end let two ancient bug reports force a monthly
  // grain on a corpus that is otherwise a fortnight old, and drew 123 bars
  // nobody can read. The 10th to 90th percentile is where the discussion
  // actually is.
  const at = (q: number) => times[Math.min(times.length - 1, Math.floor(q * (times.length - 1)))]!;
  const span = (at(0.9) - at(0.1)) / DAY_MS;

  const grain: Grain = span <= 45 ? 'day' : span <= 300 ? 'week' : 'month';

  // Then check what that actually draws. A long tail still produces buckets
  // outside the percentile window, and forty-odd bars is the most a strip this
  // size can carry before they stop being distinguishable.
  const bars = (g: Grain) => new Set(dates.map((d) => bucketOf(d, g))).size;
  if (grain === 'day' && bars('day') > 45) return bars('week') > 45 ? 'month' : 'week';
  if (grain === 'week' && bars('week') > 45) return 'month';
  return grain;
}

/** The most bars a timeline strip carries before they stop being readable.
 *
 *  Applied by dropping the oldest, not by coarsening further: month is already
 *  the coarsest grain, and GIMP's corpus reaches back to 2005, so nothing but a
 *  cut brings 123 bars into range. Taking the recent end is also the right cut
 *  for this panel — it answers "what are they talking about", which is a
 *  question about now. */
const MAX_BUCKETS = 36;

const recent = <T>(points: T[]): T[] => points.slice(-MAX_BUCKETS);

/** The bucket an ISO date falls in, as the bucket's own start date. */
export function bucketOf(iso: string, grain: Grain): string {
  if (grain === 'month') return `${iso.slice(0, 7)}-01`;
  if (grain === 'day') return iso.slice(0, 10);
  // Weeks start on Monday, so a bar means a working week rather than a
  // seven-day window whose meaning shifts with when the scan happened to run.
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  const weekday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - weekday);
  return date.toISOString().slice(0, 10);
}

export function buildBuzz(mentions: Mention[]): BuzzPoint[] {
  // Only what was actually scored.
  //
  // Averaging over the whole corpus counted every unscored mention as a 0 and
  // pulled the mean to neutral: 300 mentions with 40 judged produced a net of
  // -0.01, which is not a reading of anything. The scoring budget means most of
  // a corpus is deliberately unjudged, so this is the normal case rather than
  // an edge one.
  const judged = mentions.filter(wasScored);
  const dated = (judged.length ? judged : mentions).filter((m) => m.date);
  if (dated.length === 0) return [];

  const grain = grainFor(dated.map((m) => m.date!));
  const buckets = new Map<string, Mention[]>();
  for (const m of dated) {
    const key = bucketOf(m.date!, grain);
    buckets.set(key, [...(buckets.get(key) ?? []), m]);
  }

  return recent([...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b)))
    .map(([bucket, items]) => {
      const byVenue: Partial<Record<Venue, number>> = {};
      for (const m of items) byVenue[m.venue] = (byVenue[m.venue] ?? 0) + 1;
      return {
        bucket,
        score: items.reduce((sum, m) => sum + m.score, 0) / items.length,
        volume: items.length,
        byVenue,
      };
    });
}

/** Net sentiment now, and how far it moved across the window. */
/** Topic volume, with the run's theme vocabulary consolidated by the topics
 *  agent first.
 *
 *  Split from `buildTopics` so the arithmetic stays pure and testable and the
 *  one model call sits at the edge. If the call fails the mechanical path still
 *  produces a chart — worse, but real.
 */
/** How many distinct themes the grouping call is allowed to see, and how long
 *  it gets. Both exist because this runs against a local model: the work is
 *  proportional to the vocabulary, and the panel is worth about a minute of a
 *  scan's time, not five. */
const TOPIC_VOCABULARY_LIMIT = 60;
const TOPIC_GROUPING_TIMEOUT_MS = 150_000;

/** How many themes to hand the model at once.
 *
 *  Measured, not chosen. The run log is unambiguous: 43 themes grouped fine in
 *  29 seconds, and 47, 57, 58 and 60 all came back as `model returned an empty
 *  response` after thirty to a hundred and thirty seconds of generation. Every
 *  topics call today failed, three for three, and the whole chart fell back to
 *  mechanical merging every time.
 *
 *  The input was never the problem — the prompt is thirteen hundred characters.
 *  The output is: up to eight named groups whose members between them have to
 *  account for sixty indices, emitted under a schema, in one turn. Same failure
 *  the buzz stage had, and the same fix — ask for less per call.
 *
 *  Twenty, measured again after thirty-six failed in a real run while a
 *  twenty-four-theme batch beside it succeeded. The earlier reading of
 *  forty-three was a lucky one. Under the size that demonstrably works, rather
 *  than near the size that sometimes does.
 *
 *  The size is only half of it — see the split-and-retry below. Themes are
 *  ordered by how often they were used, so the first batch holds the head of
 *  the distribution and losing it is the expensive failure: one run grouped
 *  sixteen themes and still covered 2% of theme uses, because the batch that
 *  died held all the common ones. */
const TOPIC_BATCH = Number(process.env.TOPIC_BATCH ?? 20);

export async function groupTopics(
  company: string, mentions: Mention[], emit: Emit,
): Promise<TopicPoint[]> {
  const vocabulary = new Map<string, number>();
  for (const mention of mentions) {
    if (!mention.date) continue;
    for (const theme of new Set(mention.themes ?? [])) {
      const text = theme.trim();
      if (text) vocabulary.set(text, (vocabulary.get(text) ?? 0) + 1);
    }
  }

  // Nothing to consolidate: one call to group nine words is not worth a minute
  // of a local model's time.
  if (vocabulary.size < 12) return buildTopics(mentions);

  // The tail is cut rather than sent. Themes are ranked by how often they were
  // used, so the head carries most of the discussion, and asking a local model
  // to place two hundred labels that appear once each costs minutes of
  // generation for almost no coverage.
  const listed = [...vocabulary.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOPIC_VOCABULARY_LIMIT)
    .map(([theme, count]) => ({ theme, count }));

  const grouping = new Map<string, string>();
  const named = new Set<string>();
  let failures = 0;
  let batches = 0;

  // In batches, most-used themes first, carrying the names already chosen into
  // the next call. Carrying them is what keeps this from producing "credits &
  // pricing" in one batch and "billing" in the next: each call can see the
  // vocabulary the earlier ones settled on and reuse it, so the chunking is an
  // implementation detail rather than something visible in the chart.
  /** Group one slice, and on failure split it and try the halves.
   *
   *  A failed batch has two possible causes and this handles both. Either it
   *  was genuinely too much to emit in one turn, in which case half of it is
   *  not; or the endpoint hiccupped, in which case asking again works. The
   *  extra call is only ever paid when something already went wrong.
   *
   *  It matters most for the first slice. Themes are ordered by how often they
   *  were used, so slice one carries the head of the distribution — a run that
   *  lost it grouped sixteen themes and still covered 2% of theme uses. */
  const group = async (slice: typeof listed, depth = 0): Promise<void> => {
    batches += 1;
    try {
      const { topics } = await runAgent<{ topics: { name: string; members: number[] }[] }>(topicsAgent, {
        prompt: `Product: "${company}". Group these ${slice.length} themes.\n\n`
          + slice.map((entry, index) => `${index}: ${entry.theme} (${entry.count})`).join('\n')
          + (named.size
            ? `\n\nTopics already named for this product: ${[...named].join(', ')}.\n`
              + 'Reuse one of those names, exactly as written, whenever a theme belongs to it. '
              + 'Only invent a name for a subject none of them covers.'
            : ''),
        items: slice.length,
        note: `${slice.length} themes${depth ? ` (split ${depth})` : ''}`,
        // Time-boxed. This is one nicety on top of a chart that already works
        // without it, so it must never be the reason a scan sits there.
        timeoutMs: TOPIC_GROUPING_TIMEOUT_MS,
      });

      for (const topic of topics ?? []) {
        const name = topic.name?.trim();
        if (!name) continue;
        named.add(name);
        for (const member of topic.members ?? []) {
          // An index outside the slice is a model error, and dropping it is the
          // only safe response: there is no way to tell which theme was meant,
          // and guessing would attribute real discussion to the wrong topic.
          const entry = slice[member];
          if (entry && !grouping.has(entry.theme)) grouping.set(entry.theme, name);
        }
      }
    } catch (error) {
      const why = error instanceof Error ? error.message.slice(0, 100) : 'error';
      // Two splits deep is four themes at the smallest, and a model that cannot
      // group four themes is not going to manage two. Stop and let those fall
      // through to mechanical consolidation.
      if (slice.length > 4 && depth < 2) {
        emit('info', `topic slice of ${slice.length} failed (${why}) — splitting and retrying`);
        const half = Math.ceil(slice.length / 2);
        await group(slice.slice(0, half), depth + 1);
        await group(slice.slice(half), depth + 1);
        return;
      }
      // One failed slice costs its own themes, which then fall through to
      // mechanical consolidation. It is not a reason to throw away the slices
      // that worked — that was the old behaviour, and it meant a single empty
      // response wiped the whole chart.
      failures += 1;
      emit('warn', `topic slice of ${slice.length} failed — ${why}`);
    }
  };

  for (let start = 0; start < listed.length; start += TOPIC_BATCH) {
    await group(listed.slice(start, start + TOPIC_BATCH));
  }

  if (grouping.size === 0) {
    emit('warn', 'topic grouping produced nothing, falling back to mechanical merge');
    return buildTopics(mentions);
  }

  const covered = [...grouping.keys()].reduce((sum, theme) => sum + (vocabulary.get(theme) ?? 0), 0);
  const total = [...vocabulary.values()].reduce((sum, n) => sum + n, 0);
  emit(
    'info',
    `topics: ${grouping.size}/${listed.length} themes grouped into ${named.size} `
    + `(${Math.round((covered / total) * 100)}% of theme uses matched)`
    + (failures ? `, ${failures}/${batches} batch(es) failed` : ''),
  );

  return buildTopics(mentions, { grouping });
}

/** Discussion volume per topic over time, from the timestamps the mentions
 *  already carry.
 *
 *  Nothing here is fetched or inferred: user-generated content comes with
 *  dates, `search.ts` already parses them onto every hit, and the buzz agent
 *  already names two or three themes per mention while it is scoring it. Topic
 *  volume is those two facts crossed — theme by month — so it costs one pass
 *  over data that is already in hand. It was the last panel with no producer at
 *  all, filled by a fixture of bell curves.
 *
 *  The work that is actually needed is consolidation. A model writing themes
 *  freely across a dozen batches produces "pricing", "credits and pricing",
 *  "Credits & Pricing" and "pricing model" for one subject, and a stacked chart
 *  of ninety bands with a count of one each shows nothing. So near-duplicates
 *  are folded together and the label kept is the spelling that occurred most
 *  often — the model's own most common phrasing, not one invented here.
 *
 *  A mention with three themes counts once toward each, which is what the type
 *  means by "mentions per topic": the bands answer "how much was said about
 *  this", so a thread about both pricing and docs is genuinely about both.
 */
export function buildTopics(
  mentions: Mention[],
  options: { limit?: number; grouping?: Map<string, string> } = {},
): TopicPoint[] {
  const limit = options.limit ?? 8;
  const dated = mentions.filter((m) => m.date && (m.themes ?? []).length > 0);
  if (dated.length === 0) return [];

  // A theme the topics agent grouped answers to its group's name from here on;
  // anything it left ungrouped keeps its own wording and goes through the
  // mechanical merge below, which is also the whole path when that call failed.
  const resolve = (raw: string) => options.grouping?.get(raw.trim()) ?? raw;

  // 1. Count every theme under a normalised key, remembering the spellings.
  const counts = new Map<string, number>();
  const spellings = new Map<string, Map<string, number>>();
  for (const mention of dated) {
    for (const raw of new Set((mention.themes ?? []).map(resolve))) {
      const key = themeKey(raw);
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      const seen = spellings.get(key) ?? new Map<string, number>();
      seen.set(raw.trim(), (seen.get(raw.trim()) ?? 0) + 1);
      spellings.set(key, seen);
    }
  }

  // 2. Fold each key into the most popular key it is a variant of. Ranking
  //    first means a merge always collapses toward the more established
  //    phrasing rather than toward whichever happened to be seen first.
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const canonical = new Map<string, string>();
  for (const [key] of ranked) {
    const target = ranked.find(([other]) => other !== key && canonical.get(other) === other && isVariantOf(key, other));
    canonical.set(key, target ? canonical.get(target[0])! : key);
  }

  // 3. Rank the merged topics and keep the ones worth drawing. The chart has
  //    ten hues; past that it would reuse them and two bands would read as the
  //    same topic, which is worse than showing fewer. One slot is reserved for
  //    the remainder, so eight named topics plus "other topics" is nine.
  const merged = new Map<string, number>();
  for (const [key, count] of counts) {
    const root = canonical.get(key)!;
    merged.set(root, (merged.get(root) ?? 0) + count);
  }
  const kept = [...merged.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.min(limit, 9))
    .map(([root]) => root);
  const keptSet = new Set(kept);

  // The label is the most common spelling across every key that folded in.
  const label = new Map<string, string>();
  for (const root of kept) {
    const tally = new Map<string, number>();
    for (const [key, target] of canonical) {
      if (target !== root) continue;
      for (const [text, n] of spellings.get(key) ?? []) tally.set(text, (tally.get(text) ?? 0) + n);
    }
    const best = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0];
    label.set(root, best ? best[0] : root);
  }

  // 4. Cross with the time buckets, using the same convention AND the same
  //    grain as buildBuzz so the two charts sit on one timeline. Deriving the
  //    grain from the same dated set is what keeps them aligned; picking it
  //    twice from different inputs would let one chart show days while the
  //    other showed months.
  const grain = grainFor(dated.map((m) => m.date!));
  const buckets = new Map<string, Record<string, number>>();
  for (const mention of dated) {
    const bucket = bucketOf(mention.date!, grain);
    const row = buckets.get(bucket) ?? {};
    const already = new Set<string>();
    for (const raw of new Set((mention.themes ?? []).map(resolve))) {
      const root = canonical.get(themeKey(raw));
      // One mention counts once per topic even when two of its themes merged
      // into the same one, or "pricing" plus "credits & pricing" would count it
      // twice for a distinction that no longer exists.
      if (!root || already.has(root)) continue;
      already.add(root);
      // Everything outside the top few is pooled rather than dropped.
      //
      // Real themes are written per mention and come back nearly unique — 88
      // distinct labels across 60 mentions in testing — so the top handful
      // accounts for well under half the discussion. Dropping the rest makes a
      // busy month look quiet, which is the opposite of what this panel is for.
      // Pooling keeps the height of each month honest, and a large remainder is
      // itself the finding: attention is diffuse rather than concentrated.
      const name = keptSet.has(root) ? label.get(root)! : OTHER_TOPICS;
      if (name === OTHER_TOPICS && already.has(OTHER_TOPICS)) continue;
      already.add(name);
      row[name] = (row[name] ?? 0) + 1;
    }
    buckets.set(bucket, row);
  }

  return recent([...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b)))
    .map(([bucket, byTopic]) => ({ bucket, byTopic }));
}

/** The pooled remainder. Named so it cannot be mistaken for a topic the model
 *  actually wrote. */
const OTHER_TOPICS = 'other topics';

/** A theme reduced to something comparable: case, punctuation and connecting
 *  words dropped, so "Credits & Pricing" and "credits and pricing" are one. */
function themeKey(theme: string): string {
  return theme
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((word) => word && !THEME_STOPWORDS.has(word))
    .join(' ')
    .trim();
}

const THEME_STOPWORDS = new Set(['and', 'or', 'the', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'with', 'issues', 'issue', 'problems']);

/** True when `key` is a wordier or plural restatement of `other`.
 *
 *  Word-set containment rather than substring: "pricing" and "credits pricing"
 *  are the same subject, but "port" appearing inside "support" is not. */
function isVariantOf(key: string, other: string): boolean {
  if (!key || !other) return false;
  const a = new Set(key.split(' ').map(stem));
  const b = new Set(other.split(' ').map(stem));
  if (a.size === 0 || b.size === 0) return false;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  return [...small].every((word) => large.has(word));
}

/** Just enough stemming to collapse the plural of a theme onto its singular.
 *  Deliberately crude — a real stemmer would merge things a reader would not
 *  expect to see merged, and these are two-word noun phrases, not prose. */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('es') && !word.endsWith('ses')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

export function netSentiment(buzz: BuzzPoint[]): Scan['net'] {
  if (buzz.length === 0) return { now: 0, delta: 0 };
  const weighted = (points: BuzzPoint[]) => {
    const volume = points.reduce((sum, p) => sum + p.volume, 0);
    return volume === 0 ? 0 : points.reduce((sum, p) => sum + p.score * p.volume, 0) / volume;
  };
  const half = Math.floor(buzz.length / 2);
  const recent = buzz.slice(-Math.max(1, buzz.length - half));
  const earlier = buzz.slice(0, Math.max(1, half));
  return { now: weighted(recent), delta: weighted(recent) - weighted(earlier) };
}


/* --------------------------------------------------------- migrations ----
 *
 *  Who arrived, who left, and what they said the reason was.
 */

/** The vocabulary of a switching claim.
 *
 *  Deliberately loose. This decides only which posts are worth a model's
 *  attention, and the cost of the two errors is not symmetric: a false positive
 *  costs a line in a prompt, and a false negative means a real departure never
 *  gets read at all. The model is told, at length, that most of what reaches it
 *  will not qualify.
 *
 *  Word boundaries throughout — "moved" must not fire on "removed", and an
 *  earlier substring version of this kind of check matched "Boltt Evo" for a
 *  scan of Bolt. */
const SWITCHING = [
  /\bswitch(?:ed|ing)?\s+(?:from|to|over|away)\b/i,
  /\bmov(?:ed|ing)\s+(?:from|to|off|over|away)\b/i,
  /\bmigrat(?:ed|ing|ion)\s+(?:from|to|off|away)\b/i,
  /\bditch(?:ed|ing)\b/i,
  /\bdropp?(?:ed|ing)\s+(?:it\s+)?(?:for|in favou?r)\b/i,
  /\breplac(?:ed|ing)\s+\w+\s+with\b/i,
  /\b(?:went|going|go)\s+back\s+to\b/i,
  /\bjump(?:ed|ing)\s+ship\b/i,
  /\bcancel+ed\s+(?:my|our)\s+\w*\s*(?:subscription|plan|account)\b/i,
  /\b(?:used|use)\s+to\s+use\b/i,
  /\bgave\s+up\s+on\b/i,
  /\bcame\s+(?:over\s+)?from\b/i,
  /\bin\s+favou?r\s+of\b/i,
];

/** How many candidates are read. A local model reads a batch of a dozen posts
 *  in about a minute, and this runs inside a stage that already has a sentiment
 *  pass in it — so the candidates are ranked and the tail is cut rather than
 *  queued behind an unbounded loop. */
const MIGRATION_BUDGET = Number(process.env.MIGRATION_BUDGET ?? 36);
const MIGRATION_BATCH = 12;
const MIGRATION_TIMEOUT_MS = 150_000;

/** Scrape boilerplate that uses switching vocabulary and means nothing by it.
 *
 *  x.com serves "Please enable JavaScript or switch to a supported browser" to
 *  anything without a browser engine, so every X result that failed to render
 *  arrives carrying a perfect switching phrase. On one run that was four out of
 *  four candidates. Sending those to a model to be told they are not migrations
 *  is a minute of generation to learn something a string match already knows. */
const BOILERPLATE = [
  /switch to a supported browser/i,
  /javascript is (?:disabled|not available)/i,
  /enable javascript/i,
];

const hasSwitchingLanguage = (text: string) =>
  !BOILERPLATE.some((pattern) => pattern.test(text))
  && SWITCHING.some((pattern) => pattern.test(text));

/** Read switching claims out of the mentions this scan already collected.
 *
 *  Never throws. This is one panel on a dashboard whose other panels are
 *  already populated by the time it runs, and taking the sentiment stage down
 *  because a churn chart could not be built would be a bad trade. A failure is
 *  logged and the panel stays honest about being empty.
 */
export async function findMigrations(
  company: string, mentions: Mention[], emit: Emit,
): Promise<Migration[]> {
  const candidates = mentions
    .filter((mention) => hasSwitchingLanguage(`${mention.title} ${mention.excerpt}`))
    // Discussion first, then the ones with a date — an undated migration cannot
    // be placed on the flow chart and is worth less than a dated one.
    .sort((a, b) =>
      Number(b.discussion ?? true) - Number(a.discussion ?? true)
      || Number(Boolean(b.date)) - Number(Boolean(a.date))
      || (b.date ?? '').localeCompare(a.date ?? ''))
    .slice(0, MIGRATION_BUDGET);

  if (candidates.length === 0) {
    emit('info', 'migrations: nothing in the corpus uses switching language');
    return [];
  }

  emit('info', `migrations: reading ${candidates.length} of ${mentions.length} mentions that mention switching`);

  // The page, not the snippet.
  //
  // Same treatment discovery and triage already give their corpus, and it
  // matters more here than anywhere: a search description arrives clipped, so
  // the model was quoting "I switched from Photoshop to GIMP, but this free
  // tool is..." verbatim from text that stopped mid-sentence — and the reason
  // somebody moved is exactly the half that was missing. Nearly free, because
  // the buzz stage has already fetched most of these URLs into the cache.
  const fetched = await fetchAll(candidates, (done, total, full) =>
    emit('info', `migrations: fetched ${done}/${total} (${full} with full text)`));

  const textFor = (mention: Mention) => {
    const got = fetched.get(mention.url);
    return (got?.text ?? mention.excerpt).slice(0, 900);
  };

  const found: Migration[] = [];
  let read = 0;
  let invented = 0;

  for (let start = 0; start < candidates.length; start += MIGRATION_BATCH) {
    const batch = candidates.slice(start, start + MIGRATION_BATCH);
    try {
      const result = await runAgent<{
        migrations: {
          index: number; direction: 'inbound' | 'outbound'; competitor: string;
          quote: string; reason: string; confidence: 'high' | 'low';
        }[];
      }>(migrationsAgent, {
        prompt: `Product: "${company}". Which of these ${batch.length} posts describe somebody `
          + 'actually switching to or away from it?\n\n'
          // The URL goes in, and it earns its place.
          //
          // A migration was recorded as "Photoshop → GIMP" from an article at
          // `xda-developers.com/switched-from-photoshop-to-gimp-but-this-free-
          // tool-beats-both` — a listicle about a THIRD product beating both,
          // which the slug says outright. The model was shown a title and a
          // clipped snippet and had no way to know. The host is signal too: a
          // publication is not somebody describing their own move, and the
          // instructions already exclude those if the model can tell.
          + batch.map((mention, index) =>
            `${index}: ${mention.title}\n${mention.url}`
            + `${mention.discussion === false ? '\n[a published article, not a personal post]' : ''}`
            + `\n${textFor(mention)}`).join('\n\n'),
        items: batch.length,
        note: `posts ${start + 1}–${start + batch.length}`,
        timeoutMs: MIGRATION_TIMEOUT_MS,
      });
      read += batch.length;

      for (const claim of result.migrations ?? []) {
        const mention = batch[claim.index];
        // An index outside the batch is a model error with no safe repair: there
        // is no way to tell which post was meant, and attaching a stranger's
        // words to the wrong URL is worse than dropping the claim.
        if (!mention) continue;
        const competitor = (claim.competitor ?? '').trim();
        const quote = (claim.quote ?? '').trim();
        // No competitor and no quote, no claim. A migration with nothing to
        // point at is an assertion, and this panel is only worth having if
        // every bar on it can be traced back to a sentence someone wrote.
        if (!competitor || !quote) continue;
        // "They moved from GIMP to GIMP" is a misread, not a migration.
        if (competitor.toLowerCase() === company.trim().toLowerCase()) continue;
        // The quote has to be in the text it was drawn from.
        //
        // Same rule the complaint pass applies: requiring a verbatim quote is
        // only worth something if the quote is checked, otherwise it is a field
        // the model can fill with anything. A bar on this chart is a claim that
        // a named person said a specific sentence, and an unverifiable one is
        // the worst thing this panel could show.
        if (!quotesTheSource(quote, `${mention.title} ${textFor(mention)}`)) {
          invented += 1;
          continue;
        }

        found.push({
          id: randomUUID().slice(0, 8),
          direction: claim.direction === 'outbound' ? 'outbound' : 'inbound',
          competitor,
          url: mention.url,
          venue: mention.venue,
          date: mention.date,
          author: mention.author,
          quote,
          reason: (claim.reason ?? '').trim(),
          confidence: claim.confidence === 'high' ? 'high' : 'low',
        });
      }
    } catch (error) {
      // One bad batch is not the whole pass. Say so, and keep reading.
      emit('warn', `migrations: batch ${start / MIGRATION_BATCH + 1} failed — ${
        error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (read === 0) {
    emit('warn', 'migrations: every batch failed, so the chart is empty because nothing was read — not because nobody switched');
    return [];
  }

  const inbound = found.filter((move) => move.direction === 'inbound').length;
  emit('info', `migrations: ${found.length} switching claims from ${read} posts read `
    + `(${inbound} in, ${found.length - inbound} out)`
    + (invented ? `, ${invented} dropped for quoting words that are not in the post` : ''));
  return found;
}
