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
import type { ConnectorRole, RoleBinding } from './roles.ts';

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
export function loadRaw<T>(name: string): { value: T; wroteFrom: 'real' | 'example' } {
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
export function writeRaw<T>(name: string, value: T): void {
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
  auth?:
    | { type: 'bearer'; token: string }
    | { type: 'header'; headers: Record<string, string> }
    /** Some hosted MCP endpoints authenticate on the URL rather than a header —
     *  Bright Data's is one, and it answers 401 to a perfectly good token sent
     *  as a Bearer. */
    | { type: 'query'; param: string; value: string };
  /** Set false to keep an entry documented but out of the running set. */
  enabled?: boolean;
  /** What this connector is for, and therefore where the pipeline uses it.
   *  A list: bright-data really is both a search engine and a scraper. See
   *  app/server/roles.ts. */
  roles?: ConnectorRole[];
  /** Which tool serves each declared role, and what its argument is called.
   *  Bound once when the server is added rather than guessed per call, so a
   *  renamed tool is a visible settings error instead of a silent empty. */
  bindings?: Partial<Record<ConnectorRole, RoleBinding>>;
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
/** Install a new MCP server.
 *
 *  Writes to the raw config so a `${VAR}` in an existing entry is not flattened
 *  into its resolved value on the way past — the same discipline every other
 *  writer here follows, and the reason credentials survive an edit.
 *
 *  Deliberately does NOT probe. Adding the row and finding out whether it
 *  answers are separate steps with separate failures: a server that is added
 *  but unreachable is a real, common state (it is not running yet, the token is
 *  not pasted yet) and refusing to record it means the person has nowhere to
 *  put the URL while they fix that. */
export function addConnector(entry: {
  name: string;
  url: string;
  description?: string;
  requires?: string[];
  roles?: ConnectorRole[];
  auth?: ConnectorConfig['auth'];
}): ConnectorConfig {
  const name = entry.name.trim();
  // The name is an identifier: it keys the session map, the run trace and the
  // credential list, and it appears in a URL path.
  if (!/^[a-z0-9][a-z0-9._-]{0,48}$/i.test(name)) {
    throw new Error('a connector name must be letters, numbers, dot, dash or underscore');
  }
  try {
    new URL(entry.url);
  } catch {
    throw new Error(`"${entry.url}" is not a valid URL`);
  }

  const raw = loadRaw<{ connectors: ConnectorConfig[] }>('connectors');
  if (raw.value.connectors.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`there is already a connector called "${name}"`);
  }

  const connector: ConnectorConfig = {
    name,
    url: entry.url,
    description: entry.description?.trim() || 'Added from the settings screen.',
    ...(entry.requires?.length ? { requires: entry.requires } : {}),
    ...(entry.roles?.length ? { roles: entry.roles } : {}),
    ...(entry.auth ? { auth: entry.auth } : {}),
  };
  raw.value.connectors.push(connector);
  writeRaw('connectors', raw.value);
  reloadConfig();
  return connector;
}

/** Remove a connector. Only ever called for one somebody added by hand — the
 *  shipped entries are documentation as much as configuration. */
export function removeConnector(name: string): void {
  const raw = loadRaw<{ connectors: ConnectorConfig[] }>('connectors');
  const before = raw.value.connectors.length;
  raw.value.connectors = raw.value.connectors.filter((c) => c.name !== name);
  if (raw.value.connectors.length === before) throw new Error(`no connector named "${name}"`);
  writeRaw('connectors', raw.value);
  reloadConfig();
}

export function patchConnector(
  name: string,
  changes: {
    url?: string;
    enabled?: boolean;
    roles?: ConnectorRole[];
    bindings?: Partial<Record<ConnectorRole, RoleBinding>>;
  },
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
  if (changes.roles !== undefined) connector.roles = changes.roles;
  if (changes.bindings !== undefined) {
    // Merged, not replaced: binding a server's search tool must not silently
    // drop the scrape binding it already had.
    connector.bindings = { ...(connector.bindings ?? {}), ...changes.bindings };
  }

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

/** What kind of work a model is being asked to do.
 *
 *  `general` is reading text and forming a judgement about it — scoring
 *  sentiment, triaging a complaint, grouping themes. `coding` is reasoning
 *  about source: locating a defect in unfamiliar code, writing a patch that
 *  compiles and passes tests.
 *
 *  A mid-sized general model is genuinely good at the first and noticeably
 *  worse at the second, so pinning both to one endpoint means either paying
 *  for a coding model to score tweets or asking a chat model to patch C. */
export type ModelRole = 'general' | 'coding';

/** Every role, so a save can reason about the ones a host did NOT claim. */
export const MODEL_ROLES: ModelRole[] = ['general', 'coding'];

export interface InferenceConfig {
  /** Key into `hosts`, used when a role has no host of its own. */
  default: string;
  /** Which host handles which kind of work. A role with no entry falls back to
   *  `default`, so a single-model setup needs none of this. */
  roles?: Partial<Record<ModelRole, string>>;
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
    /** Roles this host should handle from now on. */
    roles?: ModelRole[];
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
  if (changes.roles) {
    // The list is the complete set of roles THIS host handles, so a role
    // missing from it must be taken away — not merely left alone.
    //
    // The loop here only ever assigned, which made unticking a role a no-op
    // that looked like a failed save: the box came back ticked because nothing
    // had in fact changed. Roles it does not claim are deleted rather than
    // pointed somewhere else, so they fall back to `default` — which is what
    // "this host no longer does the coding" should mean when no other host has
    // volunteered for it.
    config.roles = { ...config.roles };
    for (const role of MODEL_ROLES) {
      if (changes.roles.includes(role)) config.roles[role] = hostKey;
      else if (config.roles[role] === hostKey) delete config.roles[role];
    }
  }

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
  roles: Partial<Record<ModelRole, string>>;
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
    roles: loaded.value.roles ?? {},
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
export function inferenceHost(role: ModelRole = 'general'): InferenceHost & { key: string; role: ModelRole } {
  const { value } = inferenceConfig();

  // An explicit environment override wins, then the host assigned to this role,
  // then the default. The fallback chain is what lets a machine with one model
  // keep working without knowing roles exist.
  const key = process.env.INFERENCE_HOST
    ?? value.roles?.[role]
    ?? value.default;

  const host = value.hosts[key];
  if (!host) {
    throw new Error(
      `inference host "${key}" is not in config/inference.json (have: ${Object.keys(value.hosts).join(', ') || 'none'})`,
    );
  }
  return { ...host, key, role };
}
