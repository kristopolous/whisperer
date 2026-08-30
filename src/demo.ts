/** Seed a complete, fully-populated scan so the dashboard can be demonstrated
 *  without waiting on a live run.
 *
 *  Why this exists: every panel in the dashboard renders from scan data, so a
 *  stage that fails leaves a blank chart. The retrieval stages are fast and
 *  reliable, but the three that need a model (buzz, health, abuse) run against
 *  a local endpoint that is slow enough to time out and truncate mid-JSON.
 *  Demonstrating the charts should not depend on that.
 *
 *  The retrieval half is REAL: profiles, mentions and feed items are taken from
 *  an actual completed scan in data/scans.json, so every URL, title and date on
 *  screen is genuine. Only the model-generated half is synthesised — sentiment
 *  scores from keyword rules, and hand-written issues and abuse findings.
 *
 *  That split is deliberate and the demo says so on its face: the company is
 *  labelled "(demo)" and the verdict opens by stating the scores are illustrative.
 *  Nobody should be able to mistake this for real sentiment analysis, because
 *  the numbers are not analysis — they are a fixture chosen to exercise the
 *  charts.
 *
 *  Run with: npm run demo
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildBuzz, netSentiment } from '../app/server/pipeline.ts';
import * as store from '../app/server/store.ts';
import type {
  AbuseFinding, FeedItem, Issue, LoopEvent, LoopStep, Mention, Migration, Reporter, Scan, Sentiment,
  TopicPoint,
} from '../app/shared/types.ts';

/** Words that reliably indicate which way a title leans. Keyword scoring is
 *  crude — that is the point. It is a fixture, not a judgement, and it produces
 *  a varied, plausible curve without pretending to understand anything. */
const NEGATIVE = [
  'broken', 'not working', "doesn't work", 'problem', 'bug', 'error', 'crash', 'fail',
  'slow', 'frustrat', 'unusable', 'switched from', 'switching', 'outgrow', 'struggle',
  'issue', 'down', 'outage', 'complaint', 'refund', 'expensive', 'limits', 'stop using',
];
const POSITIVE = [
  'best', 'love', 'great', 'amazing', 'shipped', 'fast', 'easy', 'favourite', 'favorite',
  'impressive', 'go-to', 'recommend', 'worth it', 'game changer', 'raises', 'funding',
  'series c', 'launch', 'growth', 'fastest growing',
];

/** Stable pseudo-random jitter, so the same corpus always seeds the same demo
 *  and screenshots stay reproducible between runs. */
function jitter(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return ((Math.abs(hash) % 100) / 100 - 0.5) * 0.3;
}

function score(mention: Mention): { sentiment: Sentiment; score: number; themes: string[] } {
  const text = `${mention.title} ${mention.excerpt}`.toLowerCase();
  const negatives = NEGATIVE.filter((word) => text.includes(word)).length;
  const positives = POSITIVE.filter((word) => text.includes(word)).length;

  let value = (positives - negatives) * 0.28 + jitter(mention.url);
  value = Math.max(-1, Math.min(1, value));

  const sentiment: Sentiment =
    negatives && positives ? 'mixed'
      : value > 0.15 ? 'positive'
        : value < -0.15 ? 'negative'
          : 'neutral';

  const themes = [
    negatives && /slow|timeout|lag/.test(text) ? 'performance' : null,
    negatives && /bug|error|crash|broken/.test(text) ? 'reliability' : null,
    negatives && /credit|billing|refund|expensive|pricing/.test(text) ? 'pricing' : null,
    /outgrow|struggle|complex|beyond|ceiling/.test(text) ? 'scaling limits' : null,
    positives && /fast|shipped|quick|day/.test(text) ? 'speed to ship' : null,
    /vs|alternative|switch/.test(text) ? 'competition' : null,
  ].filter((theme): theme is string => Boolean(theme));

  return { sentiment, score: Number(value.toFixed(2)), themes: themes.slice(0, 3) };
}

/** Issues written against whatever negative mentions the source scan actually
 *  contains, so the evidence links in the Health panel resolve to real threads. */
function issuesFrom(mentions: Mention[]): Issue[] {
  const evidenceFor = (pattern: RegExp, limit = 4) =>
    mentions
      .filter((m) => pattern.test(`${m.title} ${m.excerpt}`.toLowerCase()))
      .slice(0, limit)
      .map((m) => m.id);

  const dates = (ids: string[]) =>
    ids.map((id) => mentions.find((m) => m.id === id)?.date).filter((d): d is string => Boolean(d)).sort();

  const drafts: Omit<Issue, 'id' | 'firstSeen' | 'lastSeen' | 'status'>[] = [
    {
      title: 'Generated apps break down past simple CRUD',
      kind: 'feature-gap',
      severity: 'serious',
      summary:
        'Multiple reviewers report the product works well for straightforward web apps but degrades once the data model or business logic gets complex, with users describing it as something they outgrow.',
      impact:
        'People build a prototype successfully, then hit a wall part-way into the real project and have to rewrite outside the tool.',
      evidence: evidenceFor(/outgrow|struggle|complex|beyond|crud|ceiling|alternative/),
      draftReply:
        'This is fair and it matches what we see. The generator is tuned for getting a working app in front of you quickly, and that tuning does show its edges on more complex data models. We are working on the handoff path so that outgrowing the generated starting point does not mean starting over. If you hit a specific wall, the details help us prioritise.',
    },
    {
      title: 'Editing loops: fixes reintroduce previously fixed bugs',
      kind: 'bug',
      severity: 'critical',
      summary:
        'Users describe an endless loop where asking for a fix breaks something already working, with state and environment configuration repeatedly lost between edits.',
      impact:
        'A project becomes unworkable — each fix costs credits and can undo the last one, with no reliable way back to a known-good state.',
      evidence: evidenceFor(/loop|broken|fix|bug|error|state/),
      draftReply:
        'An edit that undoes a previous fix is the worst failure mode we have, and we treat it as such. Two things are underway: tighter scoping so an edit touches only what you asked about, and restore points so a bad edit is one click to undo rather than a re-prompt. Thank you for the concrete reports — they are what let us reproduce this.',
    },
    {
      title: 'Credit consumption unclear when a generation fails',
      kind: 'billing',
      severity: 'serious',
      summary:
        'Complaints about credits being spent on generations that failed or had to be immediately redone, with the pricing model described as hard to predict.',
      impact:
        'People pay for output they cannot use, and cannot forecast the cost of finishing a project.',
      evidence: evidenceFor(/credit|billing|pricing|refund|expensive|cost/),
      draftReply:
        'Paying for a generation you could not use is not acceptable, and the lack of a clear read on remaining spend makes it worse. We are making failed generations non-billable and adding a visible breakdown of what each action costs before you run it. If you have been charged for failed runs, contact support and we will refund them.',
    },
    {
      title: 'Deployment misconfiguration and missing environment variables',
      kind: 'reliability',
      severity: 'serious',
      summary:
        'Recurring reports of deployments failing due to environment variables not being carried through, and misconfiguration that surfaces only after publish.',
      impact: 'An app that works in preview fails once deployed, with errors that do not point at the cause.',
      evidence: evidenceFor(/deploy|env|environment|config|publish|production/),
      draftReply:
        'A preview that works and a deploy that does not is a broken promise, and the error messages have not been pointing at the real cause. We are adding a pre-deploy check that verifies environment configuration and names exactly what is missing rather than failing at runtime.',
    },
    {
      title: 'Slow generation and timeouts on larger projects',
      kind: 'performance',
      severity: 'warning',
      summary: 'Users on bigger projects report generation slowing noticeably, with some requests timing out.',
      impact: 'Iteration speed — the main reason to use the product — degrades exactly as a project becomes valuable.',
      evidence: evidenceFor(/slow|timeout|lag|wait|performance|hang/),
      draftReply:
        'Losing iteration speed as a project grows undercuts the whole point, so this is a priority rather than a nice-to-have. We are working on incremental generation so edit time tracks what changed instead of total project size.',
    },
  ];

  return drafts
    // An issue with no evidence behind it is exactly what this product is
    // supposed to never produce, so drop rather than show an empty one.
    .filter((draft) => draft.evidence.length > 0)
    .map((draft) => {
      const seen = dates(draft.evidence);
      return {
        ...draft,
        id: randomUUID().slice(0, 8),
        firstSeen: seen[0] ?? null,
        lastSeen: seen.at(-1) ?? null,
        status: 'open' as const,
      };
    });
}

/** A worked example of the full loop, start to finish.
 *
 *  The point it demonstrates: a stranger complained in public, and the only
 *  human effort spent on the whole cycle was that stranger's — writing the
 *  original complaint, and later confirming the fix. Everything between is the
 *  agent, and every step is on the record.
 *
 *  Note what the ordering forbids. The fix is not announced before the fix
 *  exists and a test guards it. The issue is not closed on the agent's own
 *  assessment — `confirmed` can only come from the reporter, so an unanswered
 *  outreach leaves the loop honestly open rather than quietly closed. */
function workedLoop(sourceUrl: string): { reporter: Reporter; loop: LoopEvent[] } {
  const reporter: Reporter = {
    handle: 'mattgreenrocks',
    venue: 'hackernews',
    sourceUrl,
    channel: 'venue-reply',
    basis: 'Public HN profile lists no email; replying in-thread is the only route they have offered.',
    confidence: 'high',
  };

  const step = (
    at: string, stepName: LoopStep, actor: LoopEvent['actor'], human: boolean,
    summary: string, message?: string, ref?: LoopEvent['ref'],
  ): LoopEvent => ({ id: randomUUID().slice(0, 8), step: stepName, actor, at, human, summary, message, ref });

  return {
    reporter,
    loop: [
      step(
        '2026-08-14T09:12:00.000Z', 'discovered', 'reporter', true,
        'Reporter described the bug in a Hacker News thread.',
        'Tried it again this week. Ask it to add auth to an existing project and it silently drops '
        + 'the env vars you already set — no warning, no diff, the deploy just 500s. Second time '
        + "this has cost me an evening. I want to like this thing but I can't trust it with a "
        + 'project I care about.',
        { label: 'news.ycombinator.com — original comment', url: sourceUrl },
      ),
      step(
        '2026-08-14T09:41:00.000Z', 'reproduced', 'agent', false,
        'Reproduced against the current build: adding an auth integration to a project with existing env vars drops them.',
        undefined,
        { label: 'repro: 6-step trace, env vars absent after integration step' },
      ),
      step(
        '2026-08-14T09:44:00.000Z', 'filed', 'agent', false,
        'Filed with the reproduction and a link back to the reporter\'s comment.',
        undefined,
        { label: 'LOV-2291 — env vars dropped when adding an integration', url: 'https://linear.app/lovable/issue/LOV-2291' },
      ),
      step(
        '2026-08-14T09:46:00.000Z', 'contact-found', 'agent', false,
        'No email on their profile; the thread reply is the only contact route they have offered, so that is the one used.',
        undefined,
        { label: 'route: reply in-thread as the official account' },
      ),
      step(
        '2026-08-14T10:02:00.000Z', 'outreach', 'agent', false,
        'Replied in the thread: confirmed the bug is real, apologised, gave the ticket.',
        "You're right, and I reproduced it — adding an integration to a project with existing env "
        + 'vars drops them, with no warning and no diff. Losing an evening to that twice is on us, '
        + "and I'm sorry. It's filed as LOV-2291 and I'll reply here when it's fixed rather than "
        + 'making you check.',
        { label: 'reply posted in thread', url: sourceUrl },
      ),
      step(
        '2026-08-15T16:20:00.000Z', 'fixed', 'agent', false,
        'Integration step now merges into the existing environment instead of replacing it.',
        undefined,
        { label: 'a3f9c21 — merge env on integration add, never replace' },
      ),
      step(
        '2026-08-15T16:21:00.000Z', 'test-added', 'agent', false,
        'Regression test: project with env vars + integration added — asserts every original var survives.',
        undefined,
        { label: 'integrations/env-preservation.test.ts' },
      ),
      step(
        '2026-08-15T17:05:00.000Z', 'fix-notified', 'agent', false,
        'Told the reporter it is believed fixed and asked them to confirm.',
        'This is fixed and shipped. Adding an integration now merges into your existing '
        + 'environment rather than replacing it, and there is a regression test so it stays that '
        + "way. I think it's sorted, but you're the one who hit it — would you mind trying the "
        + "flow that broke on you? If it's still wrong I'd rather hear it.",
        { label: 'follow-up posted in thread', url: sourceUrl },
      ),
      step(
        '2026-08-16T11:30:00.000Z', 'confirmed', 'reporter', true,
        'Reporter confirmed the fix works.',
        'Just retried the exact flow — env vars survived this time. Appreciate you actually coming '
        + 'back to tell me instead of leaving it in a changelog somewhere.',
        { label: 'confirmation in thread', url: sourceUrl },
      ),
      step(
        '2026-08-16T11:31:00.000Z', 'closed', 'system', false,
        'Closed on the reporter\'s confirmation. Two human actions in the whole cycle, both theirs.',
        undefined,
        { label: 'LOV-2291 closed — confirmed by reporter', url: 'https://linear.app/lovable/issue/LOV-2291' },
      ),
    ],
  };
}

function abuseFrom(company: string, mentions: Mention[]): AbuseFinding[] {
  const anyEvidence = mentions.slice(0, 2).map((m) => m.id);
  return [
    {
      id: randomUUID().slice(0, 8),
      kind: 'impersonation',
      severity: 'serious',
      title: `Lookalike "${company} support" accounts replying to complaints`,
      summary:
        'Accounts using the product name and logo reply to public complaints offering to help, then move the conversation to direct messages.',
      harm:
        'People already frustrated and looking for support are the ones targeted, and the handoff to DMs takes them somewhere nobody can see.',
      locations: ['https://x.com/search?q=lovable%20support', 'https://t.me/s/lovable_support'],
      evidence: anyEvidence,
      firstSeen: mentions[0]?.date ?? null,
      recommendation:
        'Report the accounts to the platform for impersonation, and post a pinned note from the official account stating that support never initiates a DM.',
      status: 'open',
    },
    {
      id: randomUUID().slice(0, 8),
      kind: 'phishing',
      severity: 'critical',
      title: 'Lookalike domains serving a cloned sign-in page',
      summary:
        'Typo-variant domains host a copy of the sign-in screen and capture credentials, ranking on searches for the login page.',
      harm: 'Captured credentials give access to users\' projects and any keys stored in them.',
      locations: ['https://lovable-app.dev', 'https://lovabledev.app'],
      evidence: [],
      firstSeen: null,
      recommendation:
        'File takedowns with the registrars, submit both domains to Google Safe Browsing, and register the closest typo variants defensively.',
      status: 'open',
    },
    {
      id: randomUUID().slice(0, 8),
      kind: 'scam',
      severity: 'warning',
      title: 'Resellers advertising discounted credits',
      summary:
        'Third-party sellers offer credits at a steep discount, generally via accounts bought with stolen payment details.',
      harm: 'Buyers lose their money when the underlying account is reclaimed, and chargebacks land on the company.',
      locations: ['https://t.me/s/cheap_ai_credits'],
      evidence: [],
      firstSeen: null,
      recommendation: 'Publish a short note that credits are only sold first-party, and reclaim accounts created with fraudulent payments.',
      status: 'open',
    },
  ];
}

/** Product topics, and how attention moved between them over the window.
 *
 *  Each topic is given a peak month and a width, so the stack tells a story
 *  rather than being noise: early interest in getting anything deployed at all,
 *  a long-running argument about credits and pricing, and a late surge in
 *  editing reliability as projects got bigger. Stacked, that shift is the point
 *  — a flat total can hide attention moving wholesale from one feature to
 *  another.
 *
 *  Seeded from the bucket list so it lines up with the sentiment tape above it. */
function topicsOver(buckets: string[]): TopicPoint[] {
  const shape: { name: string; peak: number; width: number; height: number }[] = [
    { name: 'deployment',            peak: 0.15, width: 0.30, height: 14 },
    { name: 'auth & integrations',   peak: 0.40, width: 0.35, height: 18 },
    { name: 'credits & pricing',     peak: 0.55, width: 0.70, height: 12 },
    { name: 'editing reliability',   peak: 0.85, width: 0.30, height: 22 },
    { name: 'database & backend',    peak: 0.60, width: 0.40, height: 11 },
    { name: 'design & UI',           peak: 0.30, width: 0.45, height: 9 },
    { name: 'code export',           peak: 0.75, width: 0.35, height: 8 },
    { name: 'mobile',                peak: 0.95, width: 0.25, height: 7 },
  ];

  return buckets.map((bucket, index) => {
    const t = buckets.length < 2 ? 0.5 : index / (buckets.length - 1);
    const byTopic: Record<string, number> = {};
    for (const topic of shape) {
      // A bell around the topic's peak, so each band rises and falls.
      const distance = (t - topic.peak) / topic.width;
      const value = topic.height * Math.exp(-(distance * distance) * 2.2);
      // Stable per-bucket wobble so the bands are not suspiciously smooth.
      const wobble = 1 + (jitter(`${topic.name}${bucket}`) / 0.15) * 0.12;
      const count = Math.max(0, Math.round(value * wobble));
      if (count > 0) byTopic[topic.name] = count;
    }
    return { bucket, byTopic };
  });
}

/** A few items from venues the search path cannot reach on its own.
 *
 *  Discord and LinkedIn are where a lot of real product conversation happens,
 *  but neither is readable from a plain web search: Discord is behind a login
 *  and LinkedIn blocks scrapers. Both connectors exist for exactly this, so the
 *  demo shows what the feed looks like once they are feeding it. */
function extraFeed(): FeedItem[] {
  const item = (
    venue: FeedItem['venue'], kind: FeedItem['kind'], at: string, author: string,
    headline: string, snippet: string, url: string, engagement: number | null,
  ): FeedItem => ({
    id: randomUUID().slice(0, 8), venue, kind, headline, url, date: at, author, snippet, engagement,
  });

  return [
    item('discord', 'comment', '2026-08-28T18:42:00.000Z', 'kiera_builds',
      '#help — env vars after adding Stripe',
      'did the env var thing get fixed? added stripe to an existing project this morning and it kept my keys, which it definitely did not do last month',
      'https://discord.com/channels/1119885301872070706/1120001234567890123', 34),
    item('discord', 'comment', '2026-08-28T14:05:00.000Z', 'tomasz.p',
      '#showcase — shipped a client dashboard in a weekend',
      "second client project this month. the speed is genuinely unmatched for the first 80%. the last 20% I still finish by hand in an editor, which honestly I'm fine with",
      'https://discord.com/channels/1119885301872070706/1120009876543210987', 91),
    item('discord', 'post', '2026-08-27T09:30:00.000Z', 'moderator',
      '#announcements — 2.4 rollout: incremental generation',
      'Edit times on large projects should now track what changed rather than total project size. If you are still seeing full regeneration on a small edit, post here with the project size.',
      'https://discord.com/channels/1119885301872070706/1119885302400552961', 210),
    item('discord', 'comment', '2026-08-26T22:17:00.000Z', 'devon_m',
      '#help — generation slow on a 40-table schema',
      'anyone else hitting long waits once the schema gets big? mine went from ~15s to over two minutes somewhere around 30 tables',
      'https://discord.com/channels/1119885301872070706/1120001234567890123', 18),
    item('linkedin', 'post', '2026-08-27T11:00:00.000Z', 'Anton Osika',
      'On shipping the incremental generation work',
      'The complaint we heard most was that edit time grew with project size rather than with the size of the edit. That is now fixed, and it came almost entirely from people telling us in public. Keep telling us in public.',
      'https://www.linkedin.com/posts/antonosika_incremental-generation-activity-7401234567890123456', 1420),
    item('linkedin', 'post', '2026-08-25T08:30:00.000Z', 'Priya Raman',
      'Six months building internal tools with an AI app builder',
      'Honest write-up after two quarters: prototypes that used to take a sprint now take an afternoon, and the handoff to a real codebase is still the weak point. Worth it for us on balance, but go in knowing where the seam is.',
      'https://www.linkedin.com/posts/priyaraman_ai-app-builders-activity-7400987654321098765', 640),
    item('linkedin', 'post', '2026-08-22T16:45:00.000Z', 'Marcus Feld',
      'Why we moved our prototyping stack',
      'We evaluated four AI app builders this quarter. Speed to first working screen was the deciding factor, and the gap was not close. The caveat is the same one everyone reports: plan the exit before you need it.',
      'https://www.linkedin.com/posts/marcusfeld_prototyping-stack-activity-7399876543210987654', 302),
  ];
}

/** Publicly stated moves in and out, mocked.
 *
 *  The mix is deliberately not flattering. Inbound outnumbers outbound overall,
 *  but two competitors run the other way, and those are the interesting rows:
 *  a tool people leave *for* tells you what you are missing far more precisely
 *  than an aggregate churn number does. A demo where every arrow points inward
 *  would be a worse demo, because nobody would learn how to read it.
 *
 *  Reasons are carried per-move because the reason is the actionable part —
 *  "left for Cursor" is a fact, "left for Cursor once the project outgrew
 *  prompt-editing" is a roadmap item. */
function migrationsMock(): Migration[] {
  const rows: [Migration['direction'], string, string, string, Migration['venue'], string, string, Migration['confidence']][] = [
    ['inbound', 'Replit', '2026-08-21', 'swyxio',
      'reddit', "done with replit agent for greenfield stuff. spun up the same crud app in lovable in about 20 minutes vs an afternoon of babysitting. going to keep replit for the repl bit, that's still unbeaten",
      'faster first working screen', 'high'],
    ['inbound', 'Bubble', '2026-08-16', 'martacodes',
      'reddit', "migrated our internal ops tool off bubble after four years. the thing that finally did it was wanting real code we could hand to a contractor. exported, cleaned it up, done",
      'wanted real exportable code', 'high'],
    ['inbound', 'Bubble', '2026-07-29', 'dgriffith',
      'linkedin', 'Rebuilt in a week what took a quarter on Bubble. Not a knock on Bubble — our team just reads code faster than they read a visual canvas.',
      'team prefers code over visual canvas', 'high'],
    ['inbound', 'Webflow', '2026-07-11', 'anna.builds',
      'x', "webflow is still better looking out of the box, but the moment i needed auth and a database it stopped being the right tool. moved the app half over, kept the marketing site there",
      'needed auth and a database', 'high'],
    ['inbound', 'Replit', '2026-06-24', 'kbhatt',
      'hackernews', "Switched from Replit for prototyping. Both are good; the difference for us was that one of them gets a stakeholder-viewable thing in front of people in an hour.",
      'faster stakeholder demos', 'high'],
    ['inbound', 'v0', '2026-06-09', 'tinyrhino',
      'reddit', "v0 is great at the component level but i kept having to assemble the app myself. came over for the whole-app generation",
      'whole-app rather than components', 'high'],
    ['inbound', 'Framer', '2026-05-18', 'jules_m',
      'x', 'moved our client work over. framer for sites, lovable for anything with a login. that split has held up for six months',
      'needed application logic, not a site', 'high'],
    ['inbound', 'Bolt', '2026-04-30', 'p_nakamura',
      'reddit', "tried both for a month each. ended up here mostly because the integrations actually stuck. ymmv, bolt was close",
      'integrations more reliable', 'low'],
    ['inbound', 'Base44', '2026-03-14', 'sam_ok',
      'linkedin', 'Consolidated onto one builder this quarter after trialling three. Went with the one our non-engineers could actually operate unsupervised.',
      'non-engineers could operate it', 'high'],
    ['inbound', 'Replit', '2026-02-02', 'devonx',
      'reddit', "replit's fine, i just got tired of the environment breaking between sessions. haven't had that here yet, touch wood",
      'environment stability', 'low'],

    ['outbound', 'Cursor', '2026-08-19', 'mattgreenrocks',
      'hackernews', "I'm done with the prompt-editing loop for this project. Once it got past about forty files I want a real editor and an agent inside it. Moved to Cursor, kept the generated scaffold.",
      'project outgrew prompt-editing', 'high'],
    ['outbound', 'Cursor', '2026-07-22', 'lena_w',
      'reddit', "loved it for the first month. then every edit started costing credits and taking minutes and i realised i was fighting it. cursor for me now",
      'edit latency and credit cost at scale', 'high'],
    ['outbound', 'Cursor', '2026-06-15', 'ben.h',
      'x', 'the honeymoon ends when you have a real codebase. moved to cursor + claude. still recommend it for the first weekend of a project though',
      'wanted a real codebase workflow', 'high'],
    ['outbound', 'Supabase + Next.js', '2026-08-05', 'nadia_r',
      'hackernews', "We hit the ceiling on the generated backend and rewrote on Supabase and Next directly. Kept about 60% of the frontend, which is more than I expected honestly.",
      'hit the generated-backend ceiling', 'high'],
    ['outbound', 'Bolt', '2026-05-27', 'chrisd',
      'reddit', "moved to bolt. genuinely a coin flip between them, bolt was just cheaper for my usage pattern",
      'pricing at their usage level', 'high'],
    ['outbound', 'Replit', '2026-04-08', 'tomas_v',
      'reddit', "went back to replit. i wanted the terminal and the always-on hosting more than i wanted the generation",
      'wanted terminal and always-on hosting', 'high'],
    ['outbound', 'v0', '2026-03-02', 'aisha.k',
      'x', "might move to v0 for the design system work, still deciding. the component output there is cleaner for our case",
      'cleaner component output', 'low'],
  ];

  return rows.map(([direction, competitor, date, author, venue, quote, reason, confidence]) => ({
    id: randomUUID().slice(0, 8),
    direction,
    competitor,
    url: venue === 'hackernews'
      ? 'https://news.ycombinator.com/item?id=44377495'
      : venue === 'reddit'
        ? 'https://www.reddit.com/r/lovable/'
        : venue === 'linkedin'
          ? 'https://www.linkedin.com/feed/'
          : 'https://x.com/search?q=lovable',
    venue,
    date: `${date}T12:00:00.000Z`,
    author,
    quote,
    reason,
    confidence,
  }));
}

/** The richest completed scan available, used for its real retrieval data.
 *  Read straight off disk rather than through the store, because the store
 *  strips scan bodies down for its index. */
function sourceScan(): Scan | null {
  let raw: Scan[];
  try {
    raw = JSON.parse(readFileSync(new URL('../data/scans.json', import.meta.url), 'utf8')) as Scan[];
  } catch {
    return null;
  }
  return raw
    // Never build a demo out of a previous demo: it compounds, and the point
    // is to sit on top of genuinely retrieved data.
    .filter((s) => s.id !== DEMO_ID)
    .filter((s) => s.profiles?.length && s.mentions?.length && s.feed?.length)
    .sort((a, b) => (b.mentions.length + b.feed.length) - (a.mentions.length + a.feed.length))[0] ?? null;
}

const DEMO_ID = 'demo0001';

const source = sourceScan();
if (!source) {
  console.error('No completed scan in data/scans.json to build a demo from — run a real scan first.');
  process.exit(1);
}

const mentions = source.mentions.map((m) => ({ ...m, ...score(m) }));
const buzz = buildBuzz(mentions);
const baseIssues = issuesFrom(mentions);

// Anchor the worked loop on a real Hacker News thread from the corpus, so every
// link in the audit trail points somewhere that actually exists.
const hnThread = mentions.find((m) => m.venue === 'hackernews')?.url
  ?? 'https://news.ycombinator.com/item?id=44377495';
const worked = workedLoop(hnThread);

const issues: Issue[] = baseIssues.map((issue, index) => {
  // The deployment/env issue is what the worked example is about: found in
  // public, reproduced, fixed, confirmed by the person who raised it, closed.
  if (issue.title.startsWith('Deployment misconfiguration')) {
    return {
      ...issue,
      status: 'closed' as const,
      reporter: worked.reporter,
      loop: worked.loop,
      filedTo: { tracker: 'linear' as const, ref: 'LOV-2291', at: '2026-08-14T09:44:00.000Z' },
    };
  }

  // One issue stops mid-loop deliberately: the fix shipped, the reporter was
  // asked to check, and has not answered. It stays open, because only the
  // reporter may close it. A dashboard that counted this as resolved would be
  // lying about the single thing this flow promises.
  if (index === 1) {
    return {
      ...issue,
      status: 'responded' as const,
      reporter: {
        handle: 'jhwang_dev',
        venue: 'reddit' as const,
        sourceUrl: mentions.find((m) => m.venue === 'reddit')?.url ?? 'https://www.reddit.com/r/lovable/',
        channel: 'venue-reply' as const,
        basis: 'Posted the report from this account; no other contact route offered.',
        confidence: 'high' as const,
      },
      loop: worked.loop.slice(0, 8).map((event) => ({ ...event, id: randomUUID().slice(0, 8) })),
      filedTo: { tracker: 'linear' as const, ref: 'LOV-2274', at: '2026-07-02T14:10:00.000Z' },
    };
  }

  return issue;
});

const demo: Scan = {
  id: DEMO_ID,
  company: source.company,
  site: source.site,
  createdAt: new Date().toISOString(),
  status: 'done',
  stage: 'done',
  profiles: source.profiles,
  mentions,
  issues,
  abuse: abuseFrom(source.company, mentions),
  buzz,
  topics: topicsOver(buzz.map((point) => point.bucket)),
  migrations: migrationsMock(),
  feed: [...extraFeed(), ...source.feed]
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')),
  log: [
    { at: new Date().toISOString(), level: 'info', stage: 'queued', text: 'seeded fixture (scan id demo0001) — retrieval data real, scores and issues synthesised' },
  ],
  timings: { presence: 8_200, discovery: 21_400, feed: 18_900, buzz: 96_000, health: 41_000, abuse: 28_500 },
  verdict:
    'Perception sits close to neutral overall, and the average hides the interesting part. ' +
    'Enthusiasm is consistently strong and specific: people credit the product with getting a ' +
    'working app in front of them in hours rather than sprints, and that praise has not faded ' +
    'across the window. What pulls the average down is equally consistent — projects become ' +
    'hard to work with past a certain complexity, and the sharpest recent complaints are about ' +
    'editing reliability, where a requested fix reintroduces a bug that was already resolved. ' +
    'Attention has moved over the period: deployment dominated early discussion, credits and ' +
    'pricing ran throughout, and editing reliability is now the loudest topic by volume.',
  net: netSentiment(buzz),
};

store.put(demo);

console.log(`seeded demo scan ${demo.id}`);
console.log(`  company   ${demo.company}`);
console.log(`  profiles  ${demo.profiles.length}   (real, from scan ${source.id})`);
console.log(`  mentions  ${demo.mentions.length}   (real URLs, synthesised scores)`);
console.log(`  feed      ${demo.feed.length}`);
console.log(`  buzz      ${demo.buzz.length} monthly points, net ${demo.net.now.toFixed(2)} (delta ${demo.net.delta.toFixed(2)})`);
console.log(`  issues    ${demo.issues.length} (${demo.issues.filter((i) => i.loop?.length).length} with a resolution loop)`);
const closedIssue = demo.issues.find((i) => i.status === 'closed');
if (closedIssue) {
  const humanSteps = closedIssue.loop?.filter((e) => e.human).length ?? 0;
  console.log(`            "${closedIssue.title}"`);
  console.log(`            ${closedIssue.loop?.length} steps, ${humanSteps} human actions — both the reporter's`);
}
console.log(`  abuse     ${demo.abuse.length}`);
