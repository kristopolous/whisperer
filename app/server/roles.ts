/** What a connector is *for*, and therefore where the pipeline will use it.
 *
 *  Until now `config/connectors.json` was a flat list of fourteen servers and
 *  the pipeline called exactly one of them: bright-data, for two tools. The
 *  other thirteen were probed, given status dots in the settings screen, and
 *  named as dependencies in agent definitions — and never dialled by any code
 *  path. Brave is not even MCP; it is a direct HTTPS call to Brave's own API
 *  that happens to have a connector row pointing at a localhost port.
 *
 *  So a `role` field on its own would have been a label on decoration. The
 *  point of this file is the opposite arrangement: the role is what the
 *  pipeline dispatches on, so giving a server a role is what puts it to work.
 *  Install an MCP search server, mark it `search`, and discovery searches it on
 *  the next scan. Nothing else has to change, and nothing has to be hardcoded.
 *
 *  Roles are a list, not a single value, because real servers do more than one
 *  thing — bright-data genuinely is both a search engine and a scraper, and X
 *  is both somewhere to search and somewhere to reply.
 */

import type { ConnectorConfig } from './config.ts';

export const ROLES = ['search', 'scrape', 'contact', 'ticket', 'fix', 'exec'] as const;
export type ConnectorRole = (typeof ROLES)[number];

export interface RoleInfo {
  id: ConnectorRole;
  label: string;
  /** What this role does in the pipeline, in the pipeline's own terms. */
  uses: string;
  /** Whether anything reads this role yet. Stated rather than implied: a role
   *  that is declared and unused is exactly the failure this file exists to
   *  stop repeating. */
  wired: boolean;
}

export const ROLE_INFO: Record<ConnectorRole, RoleInfo> = {
  search: {
    id: 'search',
    label: 'Search',
    uses:
      'Discovery, the feed and the abuse sweep all run through this chain. Each query tries the '
      + 'providers in order and stops at the first that answers.',
    wired: true,
  },
  scrape: {
    id: 'scrape',
    label: 'Fetch pages',
    uses:
      'Reading a page a plain fetch cannot — a bot check, a login wall, heavy client rendering. An '
      + 'ordinary fetch is always tried first; this chain is what rescues it.',
    wired: true,
  },
  contact: {
    id: 'contact',
    label: 'Reach a person',
    uses:
      'Replying to whoever reported a defect. Nothing sends today — every draft goes to the outbox '
      + 'instead — so a connector here is a route that exists, not one that is used yet.',
    wired: false,
  },
  ticket: {
    id: 'ticket',
    label: 'File and track',
    uses: 'Filing a defect and appending each loop step to it. GitHub is wired directly; this is for the rest.',
    wired: false,
  },
  fix: {
    id: 'fix',
    label: 'Write the patch',
    uses:
      'Turning a diagnosed defect into a change. The built-in agent reads the source and writes '
      + 'the patch itself; a service here does that instead and opens a pull request. Whichever '
      + 'writes it, the loop still runs the suite and requires the new test to fail against the '
      + 'original code before calling anything fixed.',
    wired: true,
  },
  exec: {
    id: 'exec',
    label: 'Run tests somewhere isolated',
    uses:
      'Where a patched checkout gets its test suite run. Today that is a throwaway copy on this '
      + "machine, running the project's own test command with no sandbox at all — which is fine for "
      + 'a repository you trust and not fine for one you do not. A Daytona, Blaxel, Docker or Vagrant '
      + 'connector belongs here.',
    wired: false,
  },
};

/** How a connector satisfies one role: which tool to call, and what to call the
 *  argument.
 *
 *  Both are stored rather than guessed at call time. Tool names are not
 *  standardised — bright-data calls its search `search_engine`, another server
 *  calls it `search` or `web_search` — and neither are argument names, which
 *  are variously `query`, `q` or `keyword`. Guessing on every call means a
 *  server that works today breaks silently when it renames a tool. Binding once,
 *  visibly, means a rename is a settings error with a name attached. */
export interface RoleBinding {
  tool: string;
  /** The argument the query/url/message goes in. */
  arg: string;
  /** Fixed arguments this server needs alongside it — bright-data wants
   *  `engine: 'google'`, for instance. */
  extra?: Record<string, unknown>;
}

/** Which argument of a tool takes the thing we want to pass it.
 *
 *  A heuristic, used once when a server is first bound and then shown to the
 *  person doing the binding so they can correct it. Preferring an exact name
 *  match over a positional guess, and a required parameter over an optional
 *  one, because a wrong guess here is a tool called with its query in the
 *  wrong slot — which most servers answer with something plausible and empty. */
const PREFERRED: Record<ConnectorRole, string[]> = {
  search: ['query', 'q', 'search', 'keyword', 'keywords', 'text', 'term'],
  scrape: ['url', 'uri', 'link', 'href', 'target'],
  contact: ['message', 'text', 'body', 'content'],
  ticket: ['title', 'summary', 'subject'],
  fix: ['prompt', 'task', 'instructions', 'description', 'issue'],
  exec: ['command', 'cmd', 'script', 'code'],
};

export function guessArg(
  role: ConnectorRole, schema: { properties?: Record<string, unknown>; required?: string[] } | undefined,
): string {
  const properties = Object.keys(schema?.properties ?? {});
  if (properties.length === 0) return PREFERRED[role][0]!;
  const required = new Set(schema?.required ?? []);

  for (const candidate of PREFERRED[role]) {
    const hit = properties.find((name) => name.toLowerCase() === candidate);
    if (hit) return hit;
  }
  // Nothing recognised: the single required string is the only defensible
  // fallback, and if there is more than one there is nothing to prefer.
  const requiredProps = properties.filter((name) => required.has(name));
  return requiredProps.length === 1 ? requiredProps[0]! : properties[0]!;
}

/** The tool on this server most likely to serve a role, by name. */
export function guessTool(role: ConnectorRole, tools: { name: string }[]): string | null {
  // Word boundaries accept `-` as well as `_`: servers name tools both ways
  // and `tavily-search` is as common a shape as `web_search`.
  const wanted: Record<ConnectorRole, RegExp> = {
    search: /(^|[_-])(search|query|find)($|[_-])/i,
    scrape: /scrape|fetch|read_page|get_page|markdown|extract|browse/i,
    contact: /(send|post|reply|comment|message|dm|mail)/i,
    ticket: /(create|open|file)[_-]?\w*(issue|ticket|task)/i,
    fix: /(fix|patch|implement|resolve|code)[_-]?\w*(issue|bug|task|session)?/i,
    exec: /(exec|run|shell|command|sandbox|terminal)/i,
  };
  const pattern = wanted[role];
  return tools.find((tool) => pattern.test(tool.name))?.name ?? null;
}

/* Which connectors serve a role, and in what order, lives in providers.ts —
 * the ordering belongs to the role rather than to any connector, and the list
 * includes providers that are not MCP servers at all. */

export const bindingFor = (connector: ConnectorConfig, role: ConnectorRole): RoleBinding | undefined =>
  connector.bindings?.[role];
