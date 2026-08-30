import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';

/**
 * Everything this instance should have configured. Both lists are applied with
 * createOrUpdate, so `npm run setup` is idempotent and safe to re-run after an
 * edit here.
 */

/** Include an entry only when its credential is configured. */
const when = <T>(flag: string | undefined, entry: T): T[] => (flag ? [entry] : []);

export const mcpServers: TrueForgeApi.McpServerManifest[] = [
  {
    type: 'remote',
    name: 'discord',
    url: process.env.DISCORD_MCP_URL ?? 'http://localhost:8085/mcp',
    description:
      'Discord bot control: channels, messages, reactions, roles, moderation, webhooks, events, forums, emojis and invites.',
    // No auth block: the bot token lives in the discord-mcp container and the
    // server is only bound to loopback.
  },
  {
    type: 'remote',
    name: 'hn',
    url: process.env.HN_MCP_URL ?? 'http://localhost:8086/mcp',
    description:
      'Hacker News: top/new/Ask HN/Show HN stories, full comment threads, story search, and user profiles.',
  },
  // YouTube needs only an API key (Google Cloud Console → YouTube Data API v3),
  // not a personal account, so it's grouped with the always-on connectors above
  // rather than the when()-gated ones below.
  ...when(process.env.YOUTUBE_API_KEY, {
    type: 'remote' as const,
    name: 'youtube',
    url: process.env.YOUTUBE_MCP_URL ?? 'http://localhost:8091/mcp',
    description:
      'Search YouTube videos, channels and playlists by keyword, with view/like/comment counts and publish dates — for finding video reviews, tutorials and community reaction to a product.',
  }),

  // Instagram manages the company's own Business account through the Graph
  // API (posts, DMs, insights), not a general search — needs the app to have
  // an Instagram Business account connected to a Facebook Page.
  ...when(process.env.INSTAGRAM_ACCESS_TOKEN, {
    type: 'remote' as const,
    name: 'instagram',
    url: process.env.INSTAGRAM_MCP_URL ?? 'http://localhost:8092/mcp',
    description:
      "Manage the company's own Instagram Business account: profile info, recent posts and their engagement insights, connected Facebook pages, and DM conversations.",
  }),
  ...when(process.env.TIKNEURON_MCP_API_KEY, {
    type: 'remote' as const,
    name: 'tiktok',
    url: process.env.TIKTOK_MCP_URL ?? 'http://localhost:8093/mcp',
    description:
      'Search TikTok videos by keyword, and fetch a video\'s full metadata (creator, engagement, hashtags, duration) plus its captions/transcript — for finding video reaction and community discussion of a product.',
  }),

  // Brave Search — general web search, kept alongside Exa as a second
  // independent path so hitting one connector's rate limit doesn't stall
  // every search-shaped stage.
  ...when(process.env.BRAVE_API_KEY, {
    type: 'remote' as const,
    name: 'brave',
    url: process.env.BRAVE_MCP_URL ?? 'http://localhost:8094/mcp',
    description:
      'Brave web, news, video and image search, plus local business/place search and an AI summarizer — a general search connector independent of Exa.',
  }),

  // The rest carry a personal account rather than an API key, so each is
  // registered only once its credential is present. Registering one before it
  // can connect just puts a dead connector in front of every agent.
  ...when(process.env.TELEGRAM_SESSION_STRING, {
    type: 'remote' as const,
    name: 'telegram',
    url: process.env.TELEGRAM_MCP_URL ?? 'http://localhost:8765/mcp',
    description:
      'Telegram as your own account: list and search chats, groups and contacts, read and send messages, manage folders and drafts, and handle media.',
  }),
  ...when(process.env.SIGNAL_USER_ID, {
    type: 'remote' as const,
    name: 'signal',
    url: process.env.SIGNAL_MCP_URL ?? 'http://localhost:8089/mcp',
    description: 'Signal via a registered signal-cli number: send direct and group messages, and receive incoming ones.',
  }),
  ...when(process.env.WHATSAPP_MCP_ENABLED, {
    type: 'remote' as const,
    name: 'whatsapp',
    url: process.env.WHATSAPP_MCP_URL ?? 'http://localhost:8090/mcp',
    description:
      'WhatsApp through a linked phone: search contacts, list and read chats and message history, send messages, files and voice notes, and download media.',
  }),

  // X authenticates with an app-only bearer token from the X developer portal.
  // Registered only when the token is present, so setup stays green without it.
  ...(process.env.X_BEARER_TOKEN
    ? [{
        type: 'remote' as const,
        name: 'x',
        url: 'https://api.x.com/mcp',
        description:
          'X (Twitter) API: fetch posts and their likers/reposters/quoters, full-archive post and user search, user timelines and mentions, news, trends, bookmarks, and Articles.',
        auth: {
          type: 'header' as const,
          headers: { Authorization: `Bearer ${process.env.X_BEARER_TOKEN}` },
        },
      }]
    : []),
];

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
