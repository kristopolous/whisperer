/** What each credential is, where to get it, and what it should look like.
 *
 *  The settings screen used to be a flat list of identical masked boxes labelled
 *  with bare environment-variable names. That is an invitation to paste the
 *  wrong thing into the wrong row, and it was immediately taken: a GitHub token
 *  ended up in BRIGHTDATA_API_TOKEN *and* GITHUB_TOKEN, and the Hacker News
 *  username and password went in swapped. Every one of those failed later, at a
 *  distance, as an unexplained 401 in a stage that had nothing to do with
 *  typing them.
 *
 *  A credential is not always a secret, either. Masking a username helps nobody
 *  and makes a transposition impossible to see.
 */

export interface CredentialHint {
  /** One line: what this is. */
  what: string;
  /** Where to get it, in words. */
  where?: string;
  /** The page that actually issues it, so "where do I get this" is a click.
   *  Every one points at the console or settings screen that mints the
   *  credential — not at a marketing page — because the moment somebody needs
   *  this link is the moment they are already stuck. */
  url?: string;
  /** Where to check the balance or plan for a metered credential, when that is
   *  a different page from the one that issues it. Shown when a provider says
   *  it is out of quota. */
  billingUrl?: string;
  /** False for values that are not secret — usernames, domains, feature flags.
   *  Those render as ordinary text so a mistake is visible. */
  secret: boolean;
  /** Recognises a value that plainly belongs in a different field. */
  looksWrong?: (value: string) => string | null;
}

const startsWith = (prefix: string, label: string) => (value: string) =>
  value.startsWith(prefix) ? `this looks like ${label}` : null;

export const CREDENTIAL_HINTS: Record<string, CredentialHint> = {
  PERPLEXITY_API_KEY: {
    what: 'Perplexity search API key. Fifty results per request and a recency filter, so a scan needs far fewer requests than a twenty-per-page engine.',
    url: 'https://www.perplexity.ai/account/api/keys',
    billingUrl: 'https://www.perplexity.ai/account/api/billing',
    where: 'perplexity.ai → Settings → API',
    secret: true,
    looksWrong: (v) => (v.startsWith('pplx-') ? null : 'a Perplexity key normally starts with pplx-'),
  },
  JULES_API_KEY: {
    what: 'Google Jules API key. Hands a diagnosed defect to Jules, which reads the repository and opens a pull request on your fork. Free tier is 15 tasks a day.',
    url: 'https://jules.google.com/settings',
    billingUrl: 'https://jules.google.com/settings',
    where: 'jules.google.com → Settings → API keys',
    secret: true,
  },
  DAYTONA_API_KEY: {
    what: 'Daytona API key. Runs patched checkouts and their test suites in a disposable cloud sandbox rather than on this machine.',
    url: 'https://app.daytona.io/dashboard/keys',
    billingUrl: 'https://app.daytona.io/dashboard/billing',
    where: 'app.daytona.io → Keys',
    secret: true,
  },
  PARALLEL_API_KEY: {
    what: 'Parallel Search API key. Ranks against a natural-language objective rather than keywords, and dates most of what it returns.',
    url: 'https://platform.parallel.ai',
    billingUrl: 'https://platform.parallel.ai',
    where: 'platform.parallel.ai → API keys',
    secret: true,
  },
  ANDI_API_KEY: {
    what: 'Andi Search API key. Up to a hundred results per request, date ranges and domain filters as real parameters, and a per-query cost reported on every response.',
    url: 'https://console.andiai.com/signup',
    billingUrl: 'https://console.andiai.com',
    where: 'console.andiai.com → API keys',
    secret: true,
    looksWrong: (v) => (v.startsWith('ak-') ? null : 'an Andi key normally starts with ak-'),
  },
  YDC_API_KEY: {
    what: 'you.com Search API key. Web and news results in one request, with a recency filter and real pagination. A new account starts with $100 of credit.',
    url: 'https://you.com/platform',
    billingUrl: 'https://you.com/platform',
    where: 'you.com → Platform → API keys',
    secret: true,
    looksWrong: (v) => (v.startsWith('ydc-') ? null : 'a you.com key normally starts with ydc-'),
  },
  BRAVE_API_KEY: {
    what: 'Brave Search API subscription token. The only credential general search needs.',
    url: 'https://api-dashboard.search.brave.com/app/keys',
    billingUrl: 'https://api-dashboard.search.brave.com/app/subscriptions',
    where: 'api-dashboard.search.brave.com → API Keys',
    secret: true,
    looksWrong: startsWith('ghp_', 'a GitHub token'),
  },
  BRIGHTDATA_API_TOKEN: {
    what: 'Bright Data API token, used to read pages a plain fetch cannot — Reddit, and anything behind a bot check.',
    url: 'https://brightdata.com/cp/setting/users',
    billingUrl: 'https://brightdata.com/cp/billing',
    where: 'brightdata.com → Account settings → API tokens',
    secret: true,
    looksWrong: (v) =>
      v.startsWith('ghp_') || v.startsWith('github_pat_') ? 'this looks like a GitHub token' : null,
  },
  GITHUB_TOKEN: {
    what: 'Fine-grained personal access token with Issues: read and write on the repo you file to.',
    url: 'https://github.com/settings/personal-access-tokens',
    where: 'github.com → Settings → Developer settings → Personal access tokens',
    secret: true,
    looksWrong: (v) =>
      v.startsWith('ghp_') || v.startsWith('github_pat_') || v.startsWith('gho_')
        ? null
        : 'a GitHub token normally starts with ghp_ or github_pat_',
  },
  YOUTUBE_API_KEY: {
    what: 'YouTube Data API v3 key. Needs only a Google Cloud project, not a personal account.',
    url: 'https://console.cloud.google.com/apis/credentials',
    billingUrl: 'https://console.cloud.google.com/iam-admin/quotas',
    where: 'console.cloud.google.com → APIs & Services → Credentials',
    secret: true,
    looksWrong: (v) => (v.startsWith('AIza') ? null : 'a Google API key normally starts with AIza'),
  },
  X_BEARER_TOKEN: {
    what: 'X app-only bearer token, for reading. Posting needs OAuth 2.0 user context instead.',
    url: 'https://developer.x.com/en/portal/dashboard',
    billingUrl: 'https://developer.x.com/en/portal/products',
    where: 'developer.x.com → your project → Keys and tokens',
    secret: true,
  },
  DISCORD_TOKEN: {
    what: 'Discord bot token for the connector container.',
    where: 'discord.com/developers', url: 'https://discord.com/developers/applications', secret: true,
  },
  TIKNEURON_MCP_API_KEY: {
    what: 'TikNeuron API key, for the TikTok connector.',
    url: 'https://tikneuron.com', secret: true,
  },
  INSTAGRAM_ACCESS_TOKEN: {
    what: 'Instagram Graph API token for the company\'s own Business account.',
    url: 'https://developers.facebook.com/apps', secret: true,
  },
  TELEGRAM_SESSION_STRING: {
    what: 'Telegram session string for your own account.',
    url: 'https://my.telegram.org/apps', secret: true,
  },
  SIGNAL_USER_ID: { what: 'The phone number registered with signal-cli, e.g. +15551234567.', secret: false },
  WHATSAPP_MCP_ENABLED: { what: 'Set to 1 to enable the WhatsApp connector. Not a secret — a switch.', secret: false },

  REDDIT_CLIENT_ID: {
    what: 'Reddit script-app client id.',
    where: 'reddit.com/prefs/apps', url: 'https://www.reddit.com/prefs/apps', secret: false,
  },
  REDDIT_CLIENT_SECRET: {
    what: 'Reddit script-app secret.',
    where: 'reddit.com/prefs/apps', url: 'https://www.reddit.com/prefs/apps', secret: true,
  },
  REDDIT_USERNAME: {
    what: 'Your Reddit username. Not a secret.',
    url: 'https://www.reddit.com/prefs/apps', secret: false,
  },
  REDDIT_PASSWORD: { what: 'Your Reddit account password.', secret: true },

  HN_USERNAME: {
    what: 'Your Hacker News username. Not a secret — shown so a transposition is visible.',
    url: 'https://news.ycombinator.com/login',
    secret: false,
    looksWrong: (v) =>
      (/^[A-Za-z0-9]{12,}$/.test(v) && /[A-Z]/.test(v) && /[0-9]/.test(v)) || /[^\w-]/.test(v)
        ? 'this looks like a password rather than a username'
        : null,
  },
  HN_PASSWORD: { what: 'Your Hacker News password.', url: 'https://news.ycombinator.com/login', secret: true },

  MAILGUN_API_KEY: {
    what: 'Mailgun private API key, for the (unbuilt) email channel.',
    url: 'https://app.mailgun.com/settings/api_security',
    billingUrl: 'https://app.mailgun.com/settings/billing',
    secret: true,
  },
  MAILGUN_DOMAIN: {
    what: 'The verified sending domain, e.g. mail.example.com. Not a secret.',
    url: 'https://app.mailgun.com/mg/sending/domains',
    secret: false,
  },
};

export const hintFor = (name: string): CredentialHint =>
  CREDENTIAL_HINTS[name] ?? { what: '', secret: true };

/** Values that plainly belong somewhere else, and duplicates.
 *
 *  The duplicate check earns its place: pasting one token into two fields looks
 *  fine in a list of masked boxes and fails much later as an unexplained 401. */
export function warnAbout(values: Record<string, string>, existing: Record<string, string>): string[] {
  const warnings: string[] = [];

  for (const [name, value] of Object.entries(values)) {
    if (!value) continue;
    const wrong = hintFor(name).looksWrong?.(value);
    if (wrong) warnings.push(`${name}: ${wrong}`);
  }

  const all = { ...existing, ...values };
  const seen = new Map<string, string[]>();
  for (const [name, value] of Object.entries(all)) {
    if (!value || value.length < 8) continue;
    seen.set(value, [...(seen.get(value) ?? []), name]);
  }
  for (const names of seen.values()) {
    if (names.length > 1) warnings.push(`${names.join(' and ')} hold the same value — one of them is probably wrong`);
  }

  return warnings;
}
