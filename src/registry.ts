import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';

/**
 * Skills this TrueForge instance should have configured, applied with
 * createOrUpdate so `npm run setup` is idempotent.
 *
 * The MCP connectors used to live here too. They are config now —
 * config/connectors.json, read by app/server/config.ts — because they are
 * dialled directly and a provisioning script is no longer what makes them
 * exist. `npm run setup` still pushes them to TrueForge, converted from that
 * same file by app/server/agents/trueforge.ts.
 */

export const skills: TrueForgeApi.SkillManifest[] = [
  {
    type: 'git',
    name: 'apple-appstore-reviewer',
    url: 'https://github.com/github/awesome-copilot',
    path: 'skills/apple-appstore-reviewer',
    // Pinned commit rather than "main" so the skill can't change underneath us.
    ref: process.env.APPSTORE_SKILL_REF ?? 'c0314d9bcb473fac0cc219e062735e3a3cb67cd3',
    description:
      'Audits an iOS/macOS codebase and its project metadata as an App Store reviewer would, flagging likely rejection risks and optimization opportunities.',
  },
  // Bright Data ships 21 skills in one repo; these are the three this product
  // uses. Add another by name — the path is skills/<name>.
  ...['brand-listening', 'search', 'scrape'].map((name) => ({
    type: 'git' as const,
    name: `brightdata-${name}`,
    url: 'https://github.com/brightdata/skills',
    path: `skills/${name}`,
    ref: process.env.BRIGHTDATA_SKILLS_REF ?? 'e825f02fbcd7a89087fd1053a57ddcd45113370f',
    description: {
      'brand-listening':
        "Social listening and brand reputation research over Bright Data's scraping infrastructure: collect what people say about a brand across Reddit, X, Instagram, TikTok, YouTube, news and review sites, then classify sentiment, cluster themes and deliver a cited digest.",
      search:
        'Search the web through the Bright Data CLI — Google/Bing/Yandex SERP via `bdata search`, and intent-ranked semantic discovery via `bdata discover`. Use it to find URLs worth scraping.',
      scrape:
        'Fetch web pages as clean markdown, HTML or JSON through the Bright Data CLI, including lists of URLs and paginated listings.',
    }[name]!,
  })),
  {
    type: 'git',
    name: 'extract-social-media',
    url: 'https://github.com/kristopolous/hackieskills',
    path: 'extract-social-media',
    ref: process.env.HACKIESKILLS_REF ?? '805ad689693dac8035bd3d8a2544973d7d03fd4d',
    description:
      "Given a website URL, find every social and community account that company or project runs — GitHub, LinkedIn, X, Discord, YouTube, Reddit and more — by rendering the page with a headless browser and classifying the outbound links.",
  },
  {
    type: 'git',
    name: 'find-discussions',
    url: 'https://github.com/kristopolous/hackieskills',
    path: 'find-discussions',
    ref: process.env.HACKIESKILLS_REF ?? '805ad689693dac8035bd3d8a2544973d7d03fd4d',
    description:
      'Find where people are talking about a piece of software, a company or a product — Reddit threads, Hacker News posts, forums and blogs — using Exa web search plus the Reddit and Hacker News tools, then summarize sentiment and recurring complaints.',
  },
];
