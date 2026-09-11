import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Wall-to-wall connector keys that the user pastes into the Settings tab.
 *  Kept in their own JSON file so a scan redaction loop never touches them. */
export interface RedditSettings {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  userAgent: string;
}

export interface Settings {
  reddit: RedditSettings;
}

const FILE = path.resolve(import.meta.dirname, '../../data/settings.json');

let settings: Settings = load();

function load(): Settings {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8')) as Settings;
  } catch {
    return { reddit: { clientId: '', clientSecret: '', username: '', password: '', userAgent: '' } };
  }
}

function flush() {
  mkdirSync(path.dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(settings, null, 2), { mode: 0o600 });
}

/** True when a full set of Reddit credentials are configured. */
export const redditReady = () =>
  Boolean(settings.reddit.clientId && settings.reddit.clientSecret && settings.reddit.username && settings.reddit.password);

/** Non-secret view for the client: secrets are masked so they never round-trip
 *  to the browser and leak into a scan's drawer. */
export const redditPublic = (mask = true) => {
  const s = settings.reddit;
  return {
    clientId: mask ? maskSecret(s.clientId) : s.clientId,
    clientSecret: mask ? maskSecret(s.clientSecret) : s.clientSecret,
    username: s.username,
    password: mask ? maskSecret(s.password) : s.password,
    userAgent: s.userAgent,
  };
};

/** The full credentials, for the PRAW subprocess only. */
export const redditSecret = () => settings.reddit;

export function setReddit(next: Partial<RedditSettings>) {
  settings.reddit = { ...settings.reddit, ...next };
  flush();
  return redditPublic(false);
}

const maskSecret = (value: string) => (value ? `${value.slice(0, 3)}…${value.slice(-2)}` : '');
