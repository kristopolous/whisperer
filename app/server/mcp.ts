/** A minimal MCP client over streamable-http. No SDK, no broker.
 *
 *  Every connector this project uses is an ordinary HTTP service speaking
 *  JSON-RPC at a URL — which is exactly how they were registered with TrueForge
 *  in the first place (`type: 'remote'`, plus the URL). Routing calls through a
 *  broker to reach a localhost port bought nothing and cost the thing that
 *  mattered most: when a call failed, the failure was the broker's to explain,
 *  and it did not explain it.
 *
 *  Called directly, a failure is an HTTP status and a body, attributable to one
 *  named connector, timed, and recordable in the run trace.
 *
 *  Scope is deliberately small — list the tools, call a tool. That is the whole
 *  surface this app has ever used.
 */

import { enabledConnectors, missingCredentials, usableConnectors, type ConnectorConfig } from './config.ts';
import { ROLES, type ConnectorRole } from './roles.ts';
import { roleLists } from './providers.ts';

/** MCP endpoints answer as plain JSON or as SSE frames depending on the server
 *  and the Accept header it decided to honour. Accept both. */
function decode(raw: string): unknown {
  const body = raw.includes('data:')
    ? raw.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('')
    : raw;
  return JSON.parse(body);
}

/** The endpoint to call, with the token on it when that is how the server
 *  wants to be authenticated. */
function endpointFor(connector: ConnectorConfig): string {
  if (connector.auth?.type !== 'query') return connector.url;
  const url = new URL(connector.url);
  url.searchParams.set(connector.auth.param, connector.auth.value);
  return url.toString();
}

function headers(connector: ConnectorConfig): Record<string, string> {
  const base: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (connector.auth?.type === 'bearer') base.Authorization = `Bearer ${connector.auth.token}`;
  if (connector.auth?.type === 'header') Object.assign(base, connector.auth.headers);
  return base;
}

let nextId = 1;

/** Session ids handed out by servers that require the MCP handshake, kept per
 *  connector for the life of the process. */
const sessions = new Map<string, string>();

const PROTOCOL_VERSION = '2024-11-05';

/** One JSON-RPC round trip. Returns the parsed body and the response headers,
 *  because the session id arrives as a header on initialize. */
async function post(
  connector: ConnectorConfig, body: unknown, timeoutMs: number,
): Promise<{ status: number; text: string; sessionId: string | null }> {
  const extra: Record<string, string> = {};
  const session = sessions.get(connector.name);
  if (session) extra['Mcp-Session-Id'] = session;

  const response = await fetch(endpointFor(connector), {
    method: 'POST',
    headers: { ...headers(connector), ...extra },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  return {
    status: response.status,
    text: await response.text(),
    sessionId: response.headers.get('mcp-session-id'),
  };
}

/** The MCP handshake: initialize, keep the session id, say we are initialized.
 *
 *  Not optional for every server. Bright Data's hosted endpoint answers
 *  `400 Bad Request: No valid session ID provided` to a tools/call that arrives
 *  without one — which looked like an auth problem for a long time, because the
 *  token was ALSO wrong and returning 401 over the top of it. */
async function handshake(connector: ConnectorConfig, timeoutMs: number): Promise<void> {
  const { status, text, sessionId } = await post(connector, {
    jsonrpc: '2.0',
    id: nextId++,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'whisperer', version: '1.0' },
    },
  }, timeoutMs);

  if (status >= 400) throw new Error(`${connector.name} ${status} on initialize: ${text.slice(0, 200)}`);
  if (sessionId) sessions.set(connector.name, sessionId);

  // Fire-and-forget: a server that does not want it will ignore it, and a
  // failure here should not sink a working session.
  await post(connector, { jsonrpc: '2.0', method: 'notifications/initialized' }, timeoutMs).catch(() => {});
}

async function rpc<T>(
  connector: ConnectorConfig, method: string, params: unknown, timeoutMs: number,
): Promise<T> {
  const send = () => post(connector, { jsonrpc: '2.0', id: nextId++, method, params }, timeoutMs);

  let { status, text } = await send();

  // A missing or expired session is recoverable exactly once: shake hands and
  // try again. Retrying blindly would turn a genuine auth failure into two.
  if (status === 400 && /session/i.test(text)) {
    sessions.delete(connector.name);
    await handshake(connector, timeoutMs);
    ({ status, text } = await send());
  }

  if (status >= 400) throw new Error(`${connector.name} ${status}: ${text.slice(0, 200)}`);

  const parsed = decode(text) as { result?: T; error?: { message?: string } };
  if (parsed.error) throw new Error(`${connector.name}: ${parsed.error.message ?? 'rpc error'}`);
  if (parsed.result === undefined) throw new Error(`${connector.name}: empty rpc result`);
  return parsed.result;
}

export interface McpTool {
  name: string;
  description?: string;
  /** The tool's declared arguments. Read when binding a tool to a role, so the
   *  argument the query goes in is taken from the server's own schema rather
   *  than assumed. */
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
}

/** Dialling the server is the only honest health check, so listing tools is
 *  also how a connector gets probed. */
export const listTools = (connector: ConnectorConfig, timeoutMs = 15_000) =>
  rpc<{ tools?: McpTool[] }>(connector, 'tools/list', {}, timeoutMs)
    .then((result) => result.tools ?? []);

export interface ToolResult {
  text: string;
  isError: boolean;
}

/** Every tool call this process has made, per connector and tool.
 *
 *  Exists because the only way to find out what a metered connector had cost
 *  was to log into the vendor's dashboard. Bright Data's counter said 553 of
 *  5,000 units used and nothing here could account for a single one of them —
 *  which also meant nothing could answer the more useful question, "is the
 *  budget going where it should".
 *
 *  Deliberately in memory and per-process, like the connector session map. This
 *  is for "what is this run spending", not billing; the vendor is the authority
 *  on the total. */
export interface ToolUsage {
  connector: string;
  tool: string;
  calls: number;
  errors: number;
  ms: number;
  lastAt: string;
}

const usage = new Map<string, ToolUsage>();

export const toolUsage = (): ToolUsage[] =>
  [...usage.values()].sort((a, b) => b.calls - a.calls);

export const resetToolUsage = () => usage.clear();

function record(connector: string, tool: string, ms: number, failed: boolean) {
  const key = `${connector}:${tool}`;
  const row = usage.get(key) ?? { connector, tool, calls: 0, errors: 0, ms: 0, lastAt: '' };
  row.calls += 1;
  if (failed) row.errors += 1;
  row.ms += ms;
  row.lastAt = new Date().toISOString();
  usage.set(key, row);
}

/** Call one tool and flatten its content blocks to text. */
export async function callTool(
  connector: ConnectorConfig, tool: string, args: Record<string, unknown>, timeoutMs = 60_000,
): Promise<ToolResult> {
  const started = Date.now();
  let result: { content?: { type?: string; text?: string }[]; isError?: boolean };
  try {
    result = await rpc<{ content?: { type?: string; text?: string }[]; isError?: boolean }>(
      connector, 'tools/call', { name: tool, arguments: args }, timeoutMs,
    );
  } catch (error) {
    // Counted even when it fails. A metered provider generally bills the
    // request, not the answer, so a call that errored is spend — and a
    // connector burning budget on failures is precisely what this is for.
    record(connector.name, tool, Date.now() - started, true);
    throw error;
  }
  record(connector.name, tool, Date.now() - started, Boolean(result.isError));
  const text = (result.content ?? [])
    .filter((part) => part.type === 'text' && part.text)
    .map((part) => part.text!)
    .join('\n')
    .trim();
  return { text, isError: Boolean(result.isError) };
}

/** Node's fetch reports every transport failure as the bare string "fetch
 *  failed" and hides the real reason on `cause`. The reason is the whole
 *  diagnosis — a refused connection means start the container, a DNS failure
 *  means fix the URL, a timeout means the service is wedged — so dig it out. */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  const code = cause?.code ?? cause?.message;
  if (error.name === 'TimeoutError') return 'timed out';
  return code ? `${error.message} (${code})` : error.message;
}

export interface ConnectorStatus {
  name: string;
  description: string;
  status: 'ok' | 'unconfigured' | 'down';
  tools: number;
  /** Credentials the connector declared and does not have. */
  missing: string[];
  error?: string;
  /** Round-trip time of the probe, so a connector that is technically up but
   *  takes nine seconds to list its tools is visible as such. */
  ms?: number;
  url: string;
  /** What this connector is declared to be for. */
  roles: ConnectorRole[];
  /** The subset of those that resolve to an actual tool, and therefore run. */
  bound: ConnectorRole[];
}

async function probe(connector: ConnectorConfig): Promise<ConnectorStatus> {
  const missing = missingCredentials(connector);
  const base = {
    name: connector.name,
    description: connector.description,
    missing,
    url: connector.url,
    // Which role chains this server sits in, and which of those it can
    // actually serve. A member with no tool bound does nothing, which matters
    // more in an ordered list than it did in a flat one — it can be sitting at
    // position one.
    roles: ROLES.filter((role) => roleLists()[role].includes(connector.name)),
    bound: ROLES.filter(
      (role) => roleLists()[role].includes(connector.name) && Boolean(connector.bindings?.[role]?.tool),
    ),
  };

  if (missing.length) return { ...base, status: 'unconfigured', tools: 0 };

  const started = Date.now();
  try {
    const tools = await listTools(connector);
    return { ...base, status: 'ok', tools: tools.length, ms: Date.now() - started };
  } catch (error) {
    return {
      ...base,
      status: 'down',
      tools: 0,
      ms: Date.now() - started,
      error: describe(error),
    };
  }
}

/** Probe every connector that is enabled in the config, in parallel — they are
 *  independent services and a slow one should not delay the rest. */
export const checkConnectors = (): Promise<ConnectorStatus[]> =>
  Promise.all(enabledConnectors().map(probe));

/** Connector names available to a run, without dialling anything. */
export const availableConnectors = (): string[] => usableConnectors().map((c) => c.name);
