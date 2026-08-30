/** Configuration that is data rather than code: which MCP connectors exist, and
 *  which model endpoint to run inference against.
 *
 *  Both of these used to be answerable only by asking TrueForge — the connector
 *  list lived in a provisioning script that pushed manifests to it, and the
 *  model endpoint was read back out of its settings API at call time. That made
 *  a running TrueForge a hard dependency of things that are really just a URL
 *  and a token, and it meant the answer to "what are we configured to use"
 *  lived somewhere you could not read in the repo.
 *
 *  So they are files now. Each has a committed `.example` that documents the
 *  shape and holds no secrets, and a real one beside it that is gitignored:
 *
 *      config/connectors.example.json   config/connectors.json
 *      config/inference.example.json    config/inference.json
 *
 *  The example is also the fallback — with no real file present the app starts
 *  and tells you what is missing, rather than failing to boot.
 *
 *  Secrets are referenced, not embedded. `"${BRAVE_API_KEY}"` anywhere in a
 *  value is substituted from the environment at load time, so the real config
 *  can be committed-shaped even when it holds a live endpoint, and .env stays
 *  the single place credentials actually live.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { hasSecret, secret } from './secrets.ts';

const CONFIG_DIR = path.resolve(import.meta.dirname, '../../config');

/** Replace every `${VAR}` in every string with its environment value. A missing
 *  variable resolves to empty rather than to the literal `${VAR}`, so callers
 *  can test "is this configured" with a plain falsy check. */
function interpolate<T>(node: T): T {
  if (typeof node === 'string') {
    // Resolved through the credential store, so a key typed into the settings
    // screen substitutes exactly like one exported in the environment.
    return node.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name: string) => secret(name) ?? '') as T;
  }
  if (Array.isArray(node)) return node.map(interpolate) as T;
  if (node && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, interpolate(v)]),
    ) as T;
  }
  return node;
}

export interface LoadedConfig<T> {
  value: T;
  /** Absolute path of the file actually read. */
  source: string;
  /** True when the real file is absent and the committed example is standing
   *  in — worth surfacing, because an example endpoint will not work. */
  isExample: boolean;
}

export function loadConfig<T>(name: string): LoadedConfig<T> {
  const real = path.join(CONFIG_DIR, `${name}.json`);
  const example = path.join(CONFIG_DIR, `${name}.example.json`);
  const source = existsSync(real) ? real : example;
  if (!existsSync(source)) {
    throw new Error(`no config/${name}.json and no config/${name}.example.json to fall back to`);
  }
  return {
    value: interpolate(JSON.parse(readFileSync(source, 'utf8'))) as T,
    source,
    isExample: source === example,
  };
}

/** The file's contents with NO substitution applied.
 *
 *  Anything that writes config back has to start from this, never from the
 *  loaded value. The loaded value has already had `${BRAVE_API_KEY}` replaced
 *  with the real key, so saving it would quietly bake a live secret into a file
 *  that only stays out of git because of a gitignore rule. Edit the raw text,
 *  write the raw text. */
function loadRaw<T>(name: string): { value: T; wroteFrom: 'real' | 'example' } {
  const real = path.join(CONFIG_DIR, `${name}.json`);
  const example = path.join(CONFIG_DIR, `${name}.example.json`);
  const source = existsSync(real) ? real : example;
  return {
    value: JSON.parse(readFileSync(source, 'utf8')) as T,
    wroteFrom: source === real ? 'real' : 'example',
  };
}

/** Save to `config/<name>.json`, never to the committed example. The first
 *  edit on a machine running off the example seeds the real file from it. */
function writeRaw<T>(name: string, value: T): void {
  writeFileSync(path.join(CONFIG_DIR, `${name}.json`), JSON.stringify(value, null, 2) + '\n');
}

/* ------------------------------------------------------------- connectors */

export interface ConnectorConfig {
  name: string;
  /** Streamable-HTTP MCP endpoint. */
  url: string;
  description: string;
  /** Environment variables that must be non-empty for this connector to work.
   *  A connector whose credential is missing is reported as unconfigured rather
   *  than dialled and reported as down — those are different problems with
   *  different fixes. */
  requires?: string[];
  auth?: { type: 'bearer'; token: string } | { type: 'header'; headers: Record<string, string> };
  /** Set false to keep an entry documented but out of the running set. */
  enabled?: boolean;
}

let connectorCache: LoadedConfig<{ connectors: ConnectorConfig[] }> | null = null;
let inferenceReset = false;

/** Drop the cached files so the next read picks up an edit. Editing
 *  config/connectors.json should not need a restart — the settings panel's
 *  "reconnect" button calls this and then re-probes, which is the whole of what
 *  reconnecting means now that connectors are dialled directly. */
export function reloadConfig() {
  connectorCache = null;
  inferenceCacheRef.value = null;
  inferenceReset = true;
  return inferenceReset;
}

export function connectorConfig() {
  connectorCache ??= loadConfig<{ connectors: ConnectorConfig[] }>('connectors');
  return connectorCache;
}

/** Every connector not switched off in the config — including ones missing a
 *  credential, because the settings panel has to be able to show those as
 *  unconfigured rather than silently omitting them. */
export const enabledConnectors = (): ConnectorConfig[] =>
  connectorConfig().value.connectors.filter((c) => c.enabled !== false);

/** Every credential name any connector declares, so the settings screen can ask
 *  for them by name instead of sending someone to find the right variable. */
export const declaredCredentials = (): string[] =>
  [...new Set(enabledConnectors().flatMap((c) => c.requires ?? []))].sort();

/** Configured, enabled, and holding every credential it declared it needs. */
export const usableConnectors = (): ConnectorConfig[] =>
  connectorConfig().value.connectors.filter(
    (c) => c.enabled !== false && (c.requires ?? []).every(hasSecret),
  );

/** Apply an edit from the settings dashboard to one connector.
 *
 *  Only the fields a person can sensibly own from a UI: where it lives, and
 *  whether it is in play. Credentials are deliberately not editable here —
 *  those belong in .env, and `requires` is what ties the two together. */
export function patchConnector(
  name: string, changes: { url?: string; enabled?: boolean },
): ConnectorConfig {
  const raw = loadRaw<{ connectors: ConnectorConfig[] }>('connectors');
  const connector = raw.value.connectors.find((c) => c.name === name);
  if (!connector) throw new Error(`no connector named "${name}"`);

  if (changes.url !== undefined) {
    // A URL that does not parse would turn every later probe into an
    // unexplained transport error, so reject it at the edit instead.
    try {
      new URL(changes.url);
    } catch {
      throw new Error(`"${changes.url}" is not a valid URL`);
    }
    connector.url = changes.url;
  }
  if (changes.enabled !== undefined) connector.enabled = changes.enabled;

  writeRaw('connectors', raw.value);
  connectorCache = null;
  return connector;
}

/** Why a connector is not in the usable set, for the settings panel. */
export const missingCredentials = (connector: ConnectorConfig): string[] =>
  (connector.requires ?? []).filter((key) => !hasSecret(key));

/* -------------------------------------------------------------- inference */

export interface InferenceHost {
  baseUrl: string;
  modelId: string;
  apiKey?: string;
  contextLength?: number;
  maxOutputTokens?: number;
}

export interface InferenceConfig {
  /** Key into `hosts`. */
  default: string;
  hosts: Record<string, InferenceHost>;
}

const inferenceCacheRef: { value: LoadedConfig<InferenceConfig> | null } = { value: null };

export function inferenceConfig() {
  inferenceCacheRef.value ??= loadConfig<InferenceConfig>('inference');
  return inferenceCacheRef.value;
}

/** Edit an inference host from the settings dashboard, creating it if the name
 *  is new.
 *
 *  Two rules here matter more than they look:
 *
 *   - The raw file is patched, never the loaded value. The loaded value has had
 *     `${OPENAI_API_KEY}` replaced with the actual key, so writing it back would
 *     turn an environment reference into a literal secret on disk.
 *   - `apiKey` is only touched when the caller actually sends the field. An
 *     endpoint that needs no key is the normal case for a local model, so an
 *     omitted key must mean "leave it alone" and an explicitly empty one must
 *     mean "remove it" — those cannot be the same thing.
 */
export function patchInferenceHost(
  hostKey: string,
  changes: {
    baseUrl?: string;
    modelId?: string;
    apiKey?: string;
    contextLength?: number;
    maxOutputTokens?: number;
    makeDefault?: boolean;
  },
): void {
  const raw = loadRaw<InferenceConfig>('inference');
  const config = raw.value;
  config.hosts ??= {};

  const host: InferenceHost = config.hosts[hostKey] ?? { baseUrl: '', modelId: '' };

  if (changes.baseUrl !== undefined) {
    try {
      new URL(changes.baseUrl);
    } catch {
      throw new Error(`"${changes.baseUrl}" is not a valid URL`);
    }
    host.baseUrl = changes.baseUrl.replace(/\/$/, '');
  }
  if (changes.modelId !== undefined) host.modelId = changes.modelId.trim();
  if (changes.apiKey !== undefined) {
    const key = changes.apiKey.trim();
    if (key) host.apiKey = key;
    else delete host.apiKey;
  }
  if (changes.contextLength !== undefined) host.contextLength = changes.contextLength;
  if (changes.maxOutputTokens !== undefined) host.maxOutputTokens = changes.maxOutputTokens;

  if (!host.baseUrl || !host.modelId) {
    throw new Error('an inference host needs both a baseUrl and a modelId');
  }

  config.hosts[hostKey] = host;
  if (changes.makeDefault) config.default = hostKey;

  writeRaw('inference', config);
  inferenceCacheRef.value = null;
}

/** Every configured host, WITHOUT the keys.
 *
 *  `hasKey` rather than the key itself: this is served to a browser, and a
 *  credential that has no reason to leave the machine should not. */
export function inferenceHosts(): {
  default: string;
  active: string;
  isExample: boolean;
  hosts: {
    key: string; baseUrl: string; modelId: string; hasKey: boolean;
    contextLength?: number; maxOutputTokens?: number;
  }[];
} {
  const loaded = inferenceConfig();
  return {
    default: loaded.value.default,
    active: process.env.INFERENCE_HOST ?? loaded.value.default,
    isExample: loaded.isExample,
    hosts: Object.entries(loaded.value.hosts ?? {}).map(([key, host]) => ({
      key,
      baseUrl: host.baseUrl,
      modelId: host.modelId,
      hasKey: Boolean(host.apiKey),
      contextLength: host.contextLength,
      maxOutputTokens: host.maxOutputTokens,
    })),
  };
}

/** The host to run inference against. `INFERENCE_HOST` picks a different entry
 *  without editing the file, which is what you want when switching between a
 *  local model and a hosted one mid-session. */
export function inferenceHost(): InferenceHost & { key: string } {
  const { value } = inferenceConfig();
  const key = process.env.INFERENCE_HOST ?? value.default;
  const host = value.hosts[key];
  if (!host) {
    throw new Error(
      `inference host "${key}" is not in config/inference.json (have: ${Object.keys(value.hosts).join(', ') || 'none'})`,
    );
  }
  return { ...host, key };
}
