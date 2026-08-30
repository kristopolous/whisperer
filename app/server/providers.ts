/** Who serves each role, in the order they should be tried.
 *
 *  ── Why the ordering lives here and not on the connector ───────────────────
 *
 *  Roles started as a set on each connector — `roles: ['search', 'scrape']` —
 *  which says who *can* do a job and is silent about who does it first. The
 *  order was whatever position the entry happened to occupy in the config file:
 *  invisible in the dashboard, unchangeable without hand-editing JSON, and
 *  load-bearing. When Brave ran out of its monthly allowance, "which search
 *  provider goes first" became the most important setting in the app and there
 *  was no way to see it, let alone change it.
 *
 *  So the list belongs to the role. `roles.search` is an ordered array of
 *  provider ids, first choice first, and that array is the whole answer to both
 *  "who participates" and "in what order". It also expresses something the old
 *  shape could not: a provider can be second choice for search and first choice
 *  for scraping.
 *
 *  ── What is a provider ─────────────────────────────────────────────────────
 *
 *  Two kinds, deliberately in one list. An MCP connector is one. So is Brave,
 *  which is not MCP at all — it is a direct HTTPS call that happens to have a
 *  connector row pointing at a dead localhost port. A `search` chain that only
 *  contained MCP servers would show "bright-data" alone and be lying, because
 *  Brave runs first regardless.
 *
 *  ── What does NOT belong in a chain ────────────────────────────────────────
 *
 *  Only providers that substitute for each other. Hacker News, the App Store
 *  and the GitHub issue search are not fallbacks for a web search — they are
 *  different corpora that always run, and ranking them against Brave would
 *  imply that one could stand in for the other. Those stay in the direct
 *  sources list. A chain is for "try these until one answers".
 */

import { connectorConfig, loadRaw, writeRaw, reloadConfig, usableConnectors, type ConnectorConfig } from './config.ts';
import { hasSecret } from './secrets.ts';
import { ROLES, type ConnectorRole } from './roles.ts';

/** Providers that are part of this app rather than an MCP endpoint. */
interface BuiltIn {
  id: string;
  label: string;
  description: string;
  roles: ConnectorRole[];
  requires: string[];
}

const BUILT_INS: BuiltIn[] = [
  {
    id: 'brave',
    label: 'Brave Search',
    description: 'Direct HTTPS call to Brave\'s own API — not MCP. 2,000 queries a month on the free plan.',
    roles: ['search'],
    requires: ['BRAVE_API_KEY'],
  },
  {
    id: 'fetch',
    label: 'Plain fetch',
    description: 'An ordinary HTTP GET and a readability pass. Free and instant; beaten by any bot check.',
    roles: ['scrape'],
    requires: [],
  },
];

export const builtInIds = new Set(BUILT_INS.map((b) => b.id));

export type ProviderKind = 'built-in' | 'mcp';

export interface Provider {
  id: string;
  label: string;
  description: string;
  kind: ProviderKind;
  /** Roles this provider could serve, whether or not it is enlisted in them. */
  can: ConnectorRole[];
  /** Credentials it declares and does not have. */
  missing: string[];
  /** Roles it is enlisted in, and whether it can actually run in each. A
   *  provider sitting at position one with no tool bound does nothing, which in
   *  an ordered list is worth saying loudly. */
  bound: ConnectorRole[];
}

/** The roles map, defaulted so a config written before this existed still
 *  loads. Missing means "nobody enlisted", not "everybody". */
export function roleLists(): Record<ConnectorRole, string[]> {
  const stored = (connectorConfig().value as { roles?: Partial<Record<ConnectorRole, string[]>> }).roles ?? {};
  return Object.fromEntries(
    ROLES.map((role) => [role, [...(stored[role] ?? [])]]),
  ) as Record<ConnectorRole, string[]>;
}

const connectorById = (id: string): ConnectorConfig | undefined =>
  connectorConfig().value.connectors.find((c) => c.name === id);

/** Every provider that exists, MCP and built-in, whether enlisted or not. */
export function listProviders(): Provider[] {
  const lists = roleLists();
  const enlisted = (id: string) => ROLES.filter((role) => lists[role].includes(id));

  const builtIns: Provider[] = BUILT_INS.map((b) => ({
    id: b.id,
    label: b.label,
    description: b.description,
    kind: 'built-in',
    can: b.roles,
    missing: b.requires.filter((name) => !hasSecret(name)),
    // A built-in needs no tool binding — the code that calls it is the binding.
    bound: enlisted(b.id),
  }));

  const mcp: Provider[] = connectorConfig().value.connectors
    .filter((c) => c.enabled !== false)
    .map((c) => ({
      id: c.name,
      label: c.name,
      description: c.description,
      kind: 'mcp' as const,
      // Without a tool bound there is nothing to say it can serve a role, so
      // anything it is already enlisted in counts as a claim.
      can: [...new Set([...ROLES.filter((r) => c.bindings?.[r]?.tool), ...enlisted(c.name)])],
      missing: (c.requires ?? []).filter((name) => !hasSecret(name)),
      bound: enlisted(c.name).filter((role) => Boolean(c.bindings?.[role]?.tool)),
    }));

  return [...builtIns, ...mcp];
}

/** One role's chain, in order, with everything the dashboard needs to render a
 *  row — including why a member is not pulling its weight. */
export interface ChainEntry {
  id: string;
  label: string;
  kind: ProviderKind;
  /** Present and usable right now. */
  usable: boolean;
  /** Why not, when it is not. */
  problem?: string;
}

export function chainFor(role: ConnectorRole): ChainEntry[] {
  const providers = new Map(listProviders().map((p) => [p.id, p]));
  return roleLists()[role].map((id) => {
    const provider = providers.get(id);
    if (!provider) {
      return { id, label: id, kind: 'mcp' as const, usable: false, problem: 'no such provider any more' };
    }
    const problem = provider.missing.length
      ? `needs ${provider.missing.join(', ')}`
      : provider.kind === 'mcp' && !provider.bound.includes(role)
        ? `no ${role} tool bound, so it is skipped`
        : undefined;
    return {
      id,
      label: provider.label,
      kind: provider.kind,
      usable: !problem,
      ...(problem ? { problem } : {}),
    };
  });
}

/** The MCP connectors enlisted for a role, in the configured order, skipping
 *  any that cannot actually run. Built-ins are not returned — their callers
 *  invoke them directly; `chainFor` is what says where they sit in the order. */
export function connectorsForRole(role: ConnectorRole): ConnectorConfig[] {
  const usable = new Set(usableConnectors().map((c) => c.name));
  return roleLists()[role]
    .filter((id) => !builtInIds.has(id) && usable.has(id))
    .map((id) => connectorById(id))
    .filter((c): c is ConnectorConfig => Boolean(c) && Boolean(c!.bindings?.[role]?.tool));
}

/** Where a built-in sits in a role's chain, or -1 when it is not in it. Lets
 *  the search path ask "is it my turn yet" without duplicating the ordering. */
export const positionInRole = (role: ConnectorRole, id: string): number =>
  roleLists()[role].indexOf(id);

/** Replace a role's chain. The array is the complete, ordered membership —
 *  ids not in it are removed from the role, which is what dragging one out of
 *  the list has to mean. */
export function setRoleChain(role: ConnectorRole, ids: string[]): string[] {
  const known = new Set(listProviders().map((p) => p.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`no provider called ${unknown.join(', ')}`);
  // De-duplicated rather than rejected: dropping a row onto itself is a user
  // action, not an error, and it should settle rather than fail.
  const ordered = [...new Set(ids)];

  const raw = loadRaw<{ connectors: ConnectorConfig[]; roles?: Record<string, string[]> }>('connectors');
  raw.value.roles = { ...(raw.value.roles ?? {}), [role]: ordered };
  writeRaw('connectors', raw.value);
  reloadConfig();
  return ordered;
}
