/** One direct, schema-constrained model call. No agent, no framework.
 *
 *  Why this exists rather than going through a saved agent on a platform:
 *
 *  A platform cannot reliably deliver schema-constrained JSON from a `custom`
 *  provider (which is what a local llama.cpp / Ollama endpoint is registered
 *  as). Both ways of asking fail, and they fail differently:
 *
 *    - with tools attached, llama.cpp rejects the request outright —
 *      `400 Failed to initialize samplers: failed to parse grammar` — because a
 *      json_schema response_format and a tools array cannot both be compiled
 *      into one grammar. Note that a platform injects its own built-in tools
 *      whenever features like dynamic sub-agents or generative UI are on, so an
 *      agent with no MCP servers is still affected.
 *    - with tools off, the request succeeds and the schema is simply not
 *      enforced: the model answers in markdown prose and the caller gets
 *      "no JSON in model output".
 *
 *  Called directly, the very same endpoint and the very same schema return
 *  clean, valid JSON every time.
 *
 *  Which endpoint that is comes from config/inference.json — see
 *  app/server/config.ts. One file, readable in the repo, rather than a lookup
 *  against a service that has to be running before this app can think.
 */

import { inferenceHost, type ModelRole } from './config.ts';

interface Endpoint {
  baseUrl: string;
  modelId: string;
  apiKey?: string;
  contextLength: number;
  maxOutputTokens: number;
}

/** Resolve the configured inference host to a concrete endpoint.
 *
 *  A note that cost a day: point this at the upstream endpoint, not at a proxy
 *  in front of it. The proxy in front of this setup accepts `response_format`,
 *  forwards the request without it, and returns prose with finish_reason
 *  "stop" — no error, just a schema that was never applied (and intermittent
 *  503s when its own upstream is unreachable). The identical request against
 *  the upstream returns valid JSON.
 */
export function resolveEndpoint(role: ModelRole = 'general'): Endpoint {
  const host = inferenceHost(role);
  if (!host.baseUrl) throw new Error(`inference host "${host.key}" has no baseUrl`);
  return {
    baseUrl: host.baseUrl.replace(/\/$/, ''),
    modelId: host.modelId,
    apiKey: host.apiKey || undefined,
    contextLength: host.contextLength ?? 15_000,
    maxOutputTokens: host.maxOutputTokens ?? 4_096,
  };
}

/** The schema, restated as an instruction.
 *
 *  Deliberately blunt and repetitive about the output format, because the
 *  failures are all the same shape: a model that answers the question correctly
 *  in prose, a table, or a fenced block with commentary around it. */
function schemaInstruction(schema: { name: string; schema: unknown }): string {
  return [
    'Respond with a single JSON object and nothing else.',
    'No prose before or after it, no markdown, no table, no code fence, no explanation.',
    'It must match this JSON Schema exactly:',
    JSON.stringify(schema.schema),
  ].join('\n');
}

/** Models wrap JSON in prose or fences often enough that this is not optional,
 *  even with a grammar applied. */
function parseJson<T>(raw: string): T {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1]! : raw;
  const start = body.search(/[{[]/);
  if (start === -1) throw new Error(`no JSON in model output: ${raw.slice(0, 200)}`);
  const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
  return JSON.parse(body.slice(start, end + 1)) as T;
}

export interface AskOptions {
  /** The agent-style standing instructions, sent as the system message. */
  instructions: string;
  prompt: string;
  /** A JSON Schema object — `{ name, schema }`, as in app/server/schemas.ts. */
  schema: { name: string; schema: unknown };
  /** Generation budget for this one call. */
  timeoutMs?: number;
  /** What kind of work this is, which decides which model answers it. */
  role?: ModelRole;
}

/** Pull the assistant text out of one SSE frame, tolerating both the streaming
 *  shape (`delta.content`) and the occasional server that sends a whole
 *  `message` on the final frame. */
function frameText(payload: string): string {
  try {
    const frame = JSON.parse(payload) as {
      choices?: { delta?: { content?: string }; message?: { content?: string } }[];
    };
    const choice = frame.choices?.[0];
    return choice?.delta?.content ?? choice?.message?.content ?? '';
  } catch {
    // A partial frame at a chunk boundary is normal; the caller re-buffers it.
    return '';
  }
}

/** Ask the configured model for JSON matching `schema`, and return it parsed.
 *
 *  The request streams, and that is load-bearing rather than a nicety. The
 *  endpoint this runs against sits behind a gateway with a **60 second**
 *  response timeout: a non-streaming request that takes longer to generate is
 *  answered with `502 all servers failed` at exactly sixty seconds, no matter
 *  how patient the client is. That is not a rare case here — grouping ninety
 *  themes, or triaging a batch of complaints on a local model, routinely takes
 *  two or three minutes. Streaming keeps bytes moving, so the gateway sees a
 *  live response and the generation runs to completion.
 *
 *  Diagnosed the hard way: the identical request returned 502 at 60s
 *  unstreamed and completed normally streamed.
 */
export async function askJsonDirect<T>(options: AskOptions): Promise<T> {
  const endpoint = resolveEndpoint(options.role);

  const response = await fetch(`${endpoint.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: endpoint.modelId,
      messages: [
        { role: 'system', content: options.instructions },
        { role: 'user', content: options.prompt },
        // The schema is stated in the prompt as well as in response_format.
        //
        // Not redundant: plenty of OpenAI-compatible servers accept
        // `response_format` and quietly ignore it. One of them answered a
        // scoring request with a markdown table of scores — a perfectly good
        // answer that no JSON parser will ever read — and reported success.
        // Asking in the prompt is the only part of this that works everywhere,
        // and it costs a few hundred tokens.
        { role: 'user', content: schemaInstruction(options.schema) },
      ],
      stream: true,
      response_format: {
        type: 'json_schema',
        json_schema: { name: options.schema.name, schema: options.schema.schema, strict: true },
      },
    }),
    // Local models are slow: a batch of a dozen items is a minute and a half of
    // generation, and cutting that off mid-stream loses the whole batch.
    signal: AbortSignal.timeout(options.timeoutMs ?? 600_000),
  });

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    throw new Error(`model endpoint ${response.status}: ${detail.slice(0, 200)}`);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';

  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });

    // Frames are separated by a blank line, but a chunk can split one, so only
    // whole frames are consumed and the tail is kept for the next chunk.
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        content += frameText(payload);
      }
      boundary = buffer.indexOf('\n\n');
    }
  }

  // Whatever is left when the stream ends, in case the server did not terminate
  // the last frame with a blank line.
  for (const line of buffer.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload && payload !== '[DONE]') content += frameText(payload);
  }

  if (!content.trim()) throw new Error('model returned an empty response');
  return parseJson<T>(content);
}
