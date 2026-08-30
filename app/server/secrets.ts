/** Credentials entered through the dashboard, stored on this machine.
 *
 *  Telling someone to go and edit `.env` is a bad answer from an app that has a
 *  settings screen: it means leaving the UI, finding the repo, knowing which
 *  variable name a connector wants, and restarting the server. The connector
 *  config already declares exactly which variables each connector needs, so the
 *  UI can ask for those by name and store the answers.
 *
 *  Precedence is store-then-environment. A value typed into the dashboard wins,
 *  because it is the more recent and more deliberate act; `.env` still works
 *  untouched for anyone provisioning by file, and for CI where there is no one
 *  to type anything.
 *
 *  Values live in `data/secrets.json`, which is inside the already-gitignored
 *  data directory. They are never served back to the browser — the API answers
 *  only whether something is set and where it came from.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const FILE = path.resolve(import.meta.dirname, '../../data/secrets.json');

let store: Record<string, string> | null = null;

function load(): Record<string, string> {
  if (store) return store;
  try {
    store = existsSync(FILE) ? (JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, string>) : {};
  } catch {
    // A corrupt secrets file must not stop the app booting; it just means
    // nothing is configured, which the UI already knows how to show.
    store = {};
  }
  return store;
}

/** The value for a credential: what was typed into the dashboard, else the
 *  environment. Always read through this rather than `process.env` directly, or
 *  a credential entered in the UI will be invisible to half the app. */
export function secret(name: string): string | undefined {
  const stored = load()[name];
  if (stored) return stored;
  const fromEnv = process.env[name];
  return fromEnv || undefined;
}

export const hasSecret = (name: string): boolean => Boolean(secret(name));

/** Where a credential came from, for the settings screen. */
export const secretSource = (name: string): 'dashboard' | 'environment' | 'missing' => {
  if (load()[name]) return 'dashboard';
  return process.env[name] ? 'environment' : 'missing';
};

/** Set or clear credentials. An empty string clears, which is how the UI
 *  removes one — distinct from omitting the key, which leaves it alone. */
export function setSecrets(values: Record<string, string>): void {
  const current = load();
  for (const [name, value] of Object.entries(values)) {
    // Only variable-shaped names, so a malformed request cannot write arbitrary
    // keys into the file.
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name)) continue;
    const trimmed = String(value ?? '').trim();
    if (trimmed) current[name] = trimmed;
    else delete current[name];
  }
  mkdirSync(path.dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(current, null, 2));
  store = current;
}

export const reloadSecrets = () => { store = null; };

/** Everything currently stored, for the mismatch checks. Values never leave the
 *  server — only the warnings derived from them do. */
export const storedSecrets = (): Record<string, string> => ({ ...load() });
