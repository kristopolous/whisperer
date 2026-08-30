import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  AbuseFinding, BuzzPoint, FeedItem, Issue, LogLevel, Mention, Profile, Scan, ScanEvent, Stage,
  TopicPoint, Venue,
} from '../shared/types.ts';
import { brandToken } from '../shared/name.ts';
import { fetchAll } from './content.ts';
import { runAgent } from './agents/runtime.ts';
import { abuseAgent } from './agents/abuse.ts';
import { buzzAgent } from './agents/buzz.ts';
import { healthAgent } from './agents/health.ts';
import { topicsAgent } from './agents/topics.ts';
import { verdictAgent } from './agents/verdict.ts';
import {
  braveSearch, braveSearchAll, isHomepage, isLexicalNoise, isOpinionBearing, namesCompany,
  looksLikeComplaint, platformOf, profileHandle, searchWidening, venueOf, windowLabel,
  type SearchHit,
} from './search.ts';

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '../..');
const SKILL = path.join(ROOT, 'skills/extract-social-media/scripts');

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
function pipeThrough(command: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let out = '', err = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { out += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${command} exited ${code}: ${err.slice(0, 300)}`)));
    child.stdin.end(input);
  });
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

  try {
    const { stdout: html } = await run('bash', [path.join(SKILL, 'scrape.sh'), site], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
      encoding: 'utf8',
    });

    // A bot check returns HTTP 200 with a challenge page in the body, so a
    // "successful" scrape can still carry no site content at all. Say so —
    // silently returning zero accounts reads as "this company has none".
    if (/Just a moment|Performing security verification|Checking your browser|cf-browser-verification/i.test(html)) {
      emit('warn', `${site} is behind a bot check — reading its accounts from search instead`);
    } else {
      const stdout = await pipeThrough('python3', [path.join(SKILL, 'extract_social.py'), '--base', site], html);
      const parsed = JSON.parse(stdout) as { profiles: Profile[] };
      for (const profile of parsed.profiles ?? []) {
        if (!profile?.url) continue;
        merged.set(canonicalProfileKey(profile.url), { ...profile, official: true });
      }
      emit('info', `${merged.size} accounts linked from ${company}'s own site`);
    }
  } catch (error) {
    emit('warn', `site scrape failed: ${error instanceof Error ? error.message : 'error'} — falling back to search`);
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
const SEARCH_PAGES = Number(process.env.SEARCH_PAGES ?? 3);

/** How many results discovery wants before it stops widening its window. */
const DISCOVERY_TARGET = Number(process.env.DISCOVERY_TARGET ?? 150);

/** How many complaint-shaped results to gather before the complaint pass stops
 *  widening. Separate from the general target because this is the half of the
 *  corpus the product actually exists to act on. */
const COMPLAINT_TARGET = Number(process.env.COMPLAINT_TARGET ?? 120);

/** How many mentions the corpus keeps.
 *
 *  Deliberately much larger than the number the model stages will read. Rows
 *  are nearly free — they are a title, a URL and a snippet — while scoring is
 *  minutes per few dozen. Conflating the two is what made "how much did we
 *  find" and "how much can we afford to think about" the same number, and the
 *  smaller of the two won. */
const MENTION_CAP = Number(process.env.MENTION_CAP ?? 300);

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

export async function findMentions(
  company: string, site: string, profiles: Profile[], emit: Emit,
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
  const brand = brandToken(company, site);
  if (brand.toLowerCase() !== company.toLowerCase()) {
    emit('info', `searching for "${brand}" (from ${site}) rather than the phrase "${company}"`);
  }

  // Two query sets, run as two passes and merged with a guaranteed share each.
  //
  // They used to be one list. Every result went into one pool that was then
  // ranked by recency and cut to the scoring budget — and since announcements
  // and news are always fresher than an accumulated complaint thread, the
  // complaint results were collected and then buried before the model ever read
  // them. Measured on a real corpus, complaint-bearing mentions fell from 15 of
  // 60 to 3 of 48 as the recency ranking was tightened. The product is about
  // turning gripes into fixes, so that is the corpus quietly losing its point.
  const generalQueries = [
    `site:reddit.com ${brand}`,
    `site:news.ycombinator.com ${brand}`,
    `site:x.com ${brand}`,
    `"${brand}" review`,
    `"${brand}" vs`,
    `"we use ${brand}"`,
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

  emit('info', `${generalQueries.length} general + ${complaintQueries.length} complaint searches`);

  // The general pass chases recency: what is being said right now.
  const general = await searchWidening(
    generalQueries,
    { count: 20, target: DISCOVERY_TARGET, pages: SEARCH_PAGES },
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
  const head = ordered.slice(0, SCORE_BUDGET);
  emit(
    'info',
    `${ordered.filter(isOpinionBearing).length} of ${ordered.length} look like real discussion, `
    + `${fresh} from the last ${RECENT_MONTHS} months`,
  );
  emit(
    'info',
    `${head.filter((hit) => fromComplaints.has(hit.url)).length}/${head.length} of the mentions the `
    + `model will read contain complaint language`,
  );

  return ordered
    .map((hit) => ({
      id: randomUUID().slice(0, 8),
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
    }))
    .slice(0, MENTION_CAP);
}

/* ------------------------------------------------------------------- feed */

/** Pull the latest things to surface about a company — new videos, comments and
 *  posts, newest first — by running the attached search connectors (YouTube
 *  search first). */
/** How many items the feed wants before it stops widening its window. */
const FEED_TARGET = Number(process.env.FEED_TARGET ?? 120);
const FEED_CAP = Number(process.env.FEED_CAP ?? 200);

export async function findFeed(
  company: string, site: string, profiles: Profile[], emit: Emit,
): Promise<FeedItem[]> {
  // The feed is the same deterministic search, biased to fresh things and
  // sorted newest first. YouTube gets its own queries because video is the
  // feed's primary source.
  // Every one of these quotes the company name. Unquoted, `${company} news`
  // matched the word "news" against every news site's front page — which is
  // recrawled hourly and therefore always the freshest thing in any window.
  const brand = brandToken(company, site);

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
    && (!feedHost || !hit.url.includes(feedHost)));
  const irrelevant = hits.length - relevant.length;
  if (irrelevant) emit('info', `feed: dropped ${irrelevant} result(s) that never name ${brand}`);

  const kindOf = (url: string): FeedItem['kind'] => {
    if (/youtube\.com\/watch|youtu\.be\//.test(url)) return 'video';
    if (/\/comments\/.+\/.+\/.+/.test(url)) return 'comment';
    return 'post';
  };

  const items = relevant.map((hit) => ({
    id: randomUUID().slice(0, 8),
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

  // Dated items first, newest to oldest; undated ones keep search order behind
  // them rather than being dropped.
  return items
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
const SCORE_BUDGET = Number(process.env.SCORE_BUDGET ?? 60);

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
  // 4, and note this shrank twice for the same reason.
  //
  // 12 breached the model's 4,096-token output cap. 8 held while the corpus was
  // search snippets, then started timing out and truncating mid-JSON once real
  // page text was fetched: more input to read means more reasoning emitted
  // before the answer starts, and the answer has to fit in what is left. 4
  // items of real discussion is what actually completes here.
  const BATCH = 4;

  /** Characters of page text per item. Real thread text is far longer than a
   *  search snippet and has to be trimmed to leave output budget. */
  const TEXT_BUDGET = 900;
  const batches: Mention[][] = [];
  for (let i = 0; i < budgeted.length; i += BATCH) batches.push(budgeted.slice(i, i + BATCH));

  // Fetch what people actually wrote before scoring any of it. Without this the
  // model is rating Brave's meta description — SEO copy, not opinion. Only the
  // budgeted head is fetched: fetching pages nobody will read is the same waste
  // as scoring them.
  emit('info', `fetching real page text for ${budgeted.length} mentions`);
  const fetched = await fetchAll(budgeted, (done, total, full) =>
    emit('info', `fetched ${done}/${total} (${full} with full text)`));
  const fullCount = [...fetched.values()].filter((f) => f.full).length;
  emit('info', `${fullCount}/${budgeted.length} yielded real content; the rest keep their search snippet`);

  emit('info', `scoring ${budgeted.length} mentions in ${batches.length} batches of ${BATCH}`);

  const scores = new Map<string, { sentiment: Mention['sentiment']; score: number; themes?: string[] }>();
  const verdicts: string[] = [];

  for (const [index, batch] of batches.entries()) {
    const corpus = batch.map((m) => {
      const got = fetched.get(m.url);
      return {
        url: m.url,
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
        scored: { url: string; sentiment: Mention['sentiment']; score: number; themes?: string[] }[];
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

      for (const entry of scored ?? []) if (entry?.url) scores.set(entry.url, entry);
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
  for (const [index, batch] of batches.entries()) {
    try {
      const result = await runAgent<{ issues: Omit<Issue, 'id' | 'status' | 'firstSeen' | 'lastSeen'>[] }>(healthAgent, {
        prompt: `Product: "${company}". Triage these complaints.\n\n${JSON.stringify(batch)}`,
        note: `batch ${index + 1}/${batches.length}`,
        items: batch.length,
      });
      issues.push(...(result.issues ?? []));
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

  const byUrl = new Map(mentions.map((m) => [m.url, m]));
  return (issues ?? []).map((issue) => {
    const dates = (issue.evidence ?? [])
      .map((url) => byUrl.get(url)?.date)
      .filter((d): d is string => Boolean(d))
      .sort();
    return {
      ...issue,
      id: randomUUID().slice(0, 8),
      evidence: (issue.evidence ?? []).map((url) => byUrl.get(url)?.id ?? url),
      firstSeen: dates[0] ?? null,
      lastSeen: dates.at(-1) ?? null,
      status: 'open' as const,
    };
  });
}

/* ------------------------------------------------------------------- abuse */

export async function findAbuse(
  company: string, site: string, mentions: Mention[], emit: Emit,
): Promise<AbuseFinding[]> {
  // Same split as the rest of the pipeline: deterministic code goes and finds
  // the candidate pages, then the model is asked once to judge which of them
  // are actually brand abuse. Handing an agent a search tool and asking it to
  // hunt could not produce valid JSON here, and the hunting part is a fixed set
  // of queries anyway — these are the surfaces abuse shows up on.
  const brand = brandToken(company, site);
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
  const candidates = hits
    .filter((hit) => !ownHost || !hit.url.includes(ownHost))
    .slice(0, 30)
    .map((hit) => ({ url: hit.url, title: hit.title, excerpt: hit.description.slice(0, 300) }));

  if (candidates.length === 0) {
    emit('info', 'integrity sweep found nothing to judge');
    return [];
  }
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
export function buildBuzz(mentions: Mention[]): BuzzPoint[] {
  const dated = mentions.filter((m) => m.date);
  if (dated.length === 0) return [];

  const buckets = new Map<string, Mention[]>();
  for (const m of dated) {
    const key = m.date!.slice(0, 7);
    buckets.set(key, [...(buckets.get(key) ?? []), m]);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, items]) => {
      const byVenue: Partial<Record<Venue, number>> = {};
      for (const m of items) byVenue[m.venue] = (byVenue[m.venue] ?? 0) + 1;
      return {
        bucket: `${bucket}-01`,
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

  try {
    const { topics } = await runAgent<{ topics: { name: string; members: number[] }[] }>(topicsAgent, {
      prompt: `Product: "${company}". Group these ${listed.length} themes.\n\n`
        + listed.map((entry, index) => `${index}: ${entry.theme} (${entry.count})`).join('\n'),
      items: listed.length,
      // Time-boxed. This is one nicety on top of a chart that already works
      // without it, so it must never be the reason a scan sits there.
      timeoutMs: TOPIC_GROUPING_TIMEOUT_MS,
    });

    const grouping = new Map<string, string>();
    for (const topic of topics ?? []) {
      const name = topic.name?.trim();
      if (!name) continue;
      for (const member of topic.members ?? []) {
        // An index outside the list is a model error, and dropping it is the
        // only safe response: there is no way to tell which theme was meant,
        // and guessing would attribute real discussion to the wrong topic.
        const entry = listed[member];
        if (entry && !grouping.has(entry.theme)) grouping.set(entry.theme, name);
      }
    }

    const covered = [...grouping.keys()].reduce((sum, theme) => sum + (vocabulary.get(theme) ?? 0), 0);
    const total = [...vocabulary.values()].reduce((sum, n) => sum + n, 0);
    emit('info', `topics: ${listed.length} themes grouped into ${topics?.length ?? 0} (${Math.round((covered / total) * 100)}% of theme uses matched)`);

    return buildTopics(mentions, { grouping });
  } catch (error) {
    emit('warn', `topic grouping failed, falling back to mechanical merge — ${error instanceof Error ? error.message.slice(0, 120) : 'error'}`);
    return buildTopics(mentions);
  }
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

  // 4. Cross with the month buckets, using the same convention as buildBuzz so
  //    the two charts sit on one timeline.
  const buckets = new Map<string, Record<string, number>>();
  for (const mention of dated) {
    const bucket = mention.date!.slice(0, 7);
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

  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, byTopic]) => ({ bucket: `${bucket}-01`, byTopic }));
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
