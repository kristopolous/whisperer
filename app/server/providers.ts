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
import { guessTool, ROLES, type ConnectorRole } from './roles.ts';

/** Providers that are part of this app rather than an MCP endpoint. */
interface BuiltIn {
  id: string;
  label: string;
  description: string;
  roles: ConnectorRole[];
  requires: string[];
  /** Hosts this provider can serve, when it is not general-purpose. A chain
   *  member that only handles one site is still a chain member — it is skipped
   *  for everything else rather than tried and failed. */
  hosts?: string[];
}

/* A plain HTTP fetch is deliberately not in here. It is not a member of the
 * scrape chain, it is the thing the chain rescues: content.ts tries an ordinary
 * GET first, and reaches for a scraper only when the page is a bot challenge or
 * a host known to block us. Listing it as a draggable provider would offer a
 * demotion the code does not honour. The scrape chain is the escape hatches, in
 * the order they should be tried. */
const BUILT_INS: BuiltIn[] = [
  {
    id: 'perplexity',
    label: 'Perplexity Search',
    description:
      'Perplexity\'s search API. Answers with up to fifty results per request where most return '
      + 'ten or twenty, and takes a recency filter directly — so it needs far fewer requests to '
      + 'cover the same ground. Paid per request, and paced accordingly.',
    roles: ['search'],
    requires: ['PERPLEXITY_API_KEY'],
  },
  {
    id: 'jules',
    label: 'Jules',
    description:
      'Google\'s coding agent. Given the defect and the fork, it reads the repository and opens a '
      + 'pull request on it. Chosen over the alternatives because its whole flow is documented — '
      + 'an explicit auto-PR mode and a structured pull request URL on the finished session, where '
      + 'the others return an id with no documented way to resolve it. Free tier: 15 tasks a day.',
    roles: ['fix'],
    requires: ['JULES_API_KEY'],
  },
  {
    id: 'whisperer-fix',
    label: 'Built-in fix agent',
    description:
      'Reads the source against the complaint, writes a patch and runs the tests in a throwaway '
      + 'copy, retrying up to three times against the test output. Needs no account and leaves a '
      + 'full record of what it tried — and is the weaker option on a large unfamiliar repository, '
      + 'which is what the services above are for.',
    roles: ['fix'],
    requires: [],
  },
  {
    id: 'daytona',
    label: 'Daytona',
    description:
      'Runs a patched checkout\'s test suite in a disposable cloud sandbox instead of on this '
      + 'machine. The fix agent executes a stranger\'s test command against a stranger\'s '
      + 'repository, which is arbitrary code execution by design — this is where that belongs.',
    roles: ['exec'],
    requires: ['DAYTONA_API_KEY'],
  },
  {
    id: 'parallel',
    label: 'Parallel Search',
    description:
      'Parallel\'s search API. Takes a natural-language objective alongside the queries, so it '
      + 'ranks for "what people are complaining about" rather than for keyword overlap, and it '
      + 'returns passages from the page with a publish date on most of them — which is what puts '
      + 'a mention on the timeline instead of only in the count.',
    roles: ['search'],
    requires: ['PARALLEL_API_KEY'],
  },
  {
    id: 'andi',
    label: 'Andi Search',
    description:
      'Andi\'s search index over plain HTTPS. Up to a hundred results per request, real date '
      + 'ranges and domain filters, and a deep mode a deep scan can ask for. Priced by outcome '
      + 'rather than per request — it reports what each query cost — so it is capped by dollars '
      + 'spent per run as well as by the shared request budget.',
    roles: ['search'],
    requires: ['ANDI_API_KEY'],
  },
  {
    id: 'you',
    label: 'you.com Search',
    description:
      'you.com\'s search index over plain HTTPS. Web and news results in one request, a recency '
      + 'filter, and real pagination. Prepaid — a new account starts with $100 of credit — so it '
      + 'is paced per request like any metered API.',
    roles: ['search'],
    requires: ['YDC_API_KEY'],
  },
  {
    id: 'brave',
    label: 'Brave Search',
    description: 'Direct HTTPS call to Brave\'s own API — not MCP. 2,000 queries a month on the free plan.',
    roles: ['search'],
    requires: ['BRAVE_API_KEY'],
  },
  {
    id: 'reddit',
    label: 'Reddit',
    description:
      "Reddit's own API. Searches the product's dedicated subreddit (hot and new) as well as the "
      + 'site at large, and reads reddit.com threads directly instead of paying a scraper for them. '
      + 'Rate-paced to one request a second and cached for two hours.',
    roles: ['search', 'scrape'],
    requires: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USERNAME', 'REDDIT_PASSWORD'],
    hosts: ['reddit.com'],
  },
];

export const builtInIds = new Set(BUILT_INS.map((b) => b.id));

export type ProviderKind = 'built-in' | 'mcp';

export interface Provider {
  id: string;
  label: string;
  description: string;
  kind: ProviderKind;
  /** Hosts it is limited to, when it is not general-purpose. */
  hosts?: string[];
  /** Roles this provider looks like it could serve, from the tools it
   *  advertises. A hint for the person choosing, never a gate on the choice.
   *
   *  Deliberately not enforced. A new MCP server is an unknown quantity — its
   *  tool names are its own and a heuristic over them is a guess, so refusing
   *  an assignment it does not endorse would block correct configurations to
   *  prevent incorrect ones. The list says what it looks like; the person
   *  decides, and owns being wrong. Being wrong is also cheap and loud: the
   *  tool either answers usefully or it does not, and the run trace says which. */
  likely: ConnectorRole[];
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
    ...(b.hosts ? { hosts: b.hosts } : {}),
    likely: b.roles,
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
      // Bound tools first — a binding is a statement, not a guess. Beyond
      // those, whatever its advertised tool names resemble, when it has been
      // dialled at least once.
      likely: [...new Set([
        ...ROLES.filter((r) => c.bindings?.[r]?.tool),
        ...ROLES.filter((r) => guessTool(r, (c.tools ?? []).map((name) => ({ name })))),
      ])],
      missing: (c.requires ?? []).filter((name) => !hasSecret(name)),
      bound: enlisted(c.name).filter((role) => Boolean(c.bindings?.[role]?.tool)),
    }));

  // A built-in wins a name collision. Brave shipped with an MCP connector row
  // pointing at a localhost port that was never running and never dialled —
  // Brave is a direct HTTPS call — and while that row existed it shadowed the
  // real provider, so the search chain reported its own first choice as "no
  // search tool bound, so it is skipped". The row is gone; this keeps the next
  // one from doing the same thing quietly.
  const seen = new Set(builtIns.map((p) => p.id));
  return [...builtIns, ...mcp.filter((p) => !seen.has(p.id))];
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
  /** Hosts it is limited to. Position one in a chain implies "asked first for
   *  everything", which for a single-site provider is not true — it is asked
   *  first for its own site and skipped otherwise. Worth saying on the row. */
  hosts?: string[];
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
      ...(provider.hosts ? { hosts: provider.hosts } : {}),
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
