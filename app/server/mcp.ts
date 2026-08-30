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

/** MCP endpoints answer as plain JSON or as SSE frames depending on the server
 *  and the Accept header it decided to honour. Accept both. */
function decode(raw: string): unknown {
  const body = raw.includes('data:')
    ? raw.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('')
    : raw;
  return JSON.parse(body);
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

async function rpc<T>(
  connector: ConnectorConfig, method: string, params: unknown, timeoutMs: number,
): Promise<T> {
  const response = await fetch(connector.url, {
    method: 'POST',
    headers: headers(connector),
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`${connector.name} ${response.status}: ${detail.slice(0, 200)}`);
  }

  const parsed = decode(await response.text()) as { result?: T; error?: { message?: string } };
  if (parsed.error) throw new Error(`${connector.name}: ${parsed.error.message ?? 'rpc error'}`);
  if (parsed.result === undefined) throw new Error(`${connector.name}: empty rpc result`);
  return parsed.result;
}

export interface McpTool {
  name: string;
  description?: string;
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

/** Call one tool and flatten its content blocks to text. */
export async function callTool(
  connector: ConnectorConfig, tool: string, args: Record<string, unknown>, timeoutMs = 60_000,
): Promise<ToolResult> {
  const result = await rpc<{ content?: { type?: string; text?: string }[]; isError?: boolean }>(
    connector, 'tools/call', { name: tool, arguments: args }, timeoutMs,
  );
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
}

async function probe(connector: ConnectorConfig): Promise<ConnectorStatus> {
  const missing = missingCredentials(connector);
  const base = { name: connector.name, description: connector.description, missing };

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
