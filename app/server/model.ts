/** One direct, schema-constrained model call. No agent, no framework.
 *
 *  Why this exists rather than going through a saved TrueForge agent:
 *
 *  TrueForge cannot deliver schema-constrained JSON from a `custom` provider
 *  (which is what a local llama.cpp / Ollama endpoint is registered as). Both
 *  ways of asking fail, and they fail differently:
 *
 *    - with tools attached, llama.cpp rejects the request outright —
 *      `400 Failed to initialize samplers: failed to parse grammar` — because a
 *      json_schema response_format and a tools array cannot both be compiled
 *      into one grammar. Note that TrueForge injects built-in tools whenever
 *      dynamicSubAgents or generativeUi are on, so an agent with no MCP servers
 *      is still affected.
 *    - with tools off, the request succeeds and the schema is simply not
 *      enforced: the model answers in markdown prose and the caller gets
 *      "no JSON in model output".
 *
 *  Called directly, the very same endpoint and the very same schema return
 *  clean, valid JSON every time. So the stages that only need classification
 *  over already-fetched text call the endpoint themselves.
 *
 *  The endpoint is still whatever the user configured in TrueForge's
 *  Settings → Models, read from TrueForge at call time — so there is one place
 *  to change the model, and this module does not become a second config.
 */

const TRUEFORGE = process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790';

interface Endpoint {
  baseUrl: string;
  modelId: string;
  apiKey?: string;
  contextLength: number;
  maxOutputTokens: number;
}

let cached: Endpoint | null = null;

/** Resolve TRUEFORGE_MODEL ("ollama/qwen3.8") to the provider base URL and the
 *  model id that provider actually expects. */
export async function resolveEndpoint(): Promise<Endpoint> {
  if (cached) return cached;

  const wanted = process.env.TRUEFORGE_MODEL ?? '';
  const [providerName, ...rest] = wanted.split('/');
  const modelName = rest.join('/');
  if (!providerName || !modelName) {
    throw new Error(`TRUEFORGE_MODEL must look like "provider/model", got "${wanted}"`);
  }

  const response = await fetch(`${TRUEFORGE}/api/v1/settings/model-providers`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`cannot read model providers from TrueForge (${response.status})`);

  const body = (await response.json()) as {
    data?: {
      name?: string;
      manifest?: {
        base_url?: string;
        auth?: { api_key?: string };
        models?: { model_id?: string; name?: string; properties?: { context_length?: number; max_output_tokens?: number } }[];
      };
    }[];
  };

  const provider = body.data?.find((entry) => entry.name === providerName);
  if (!provider?.manifest) throw new Error(`provider "${providerName}" is not configured in TrueForge`);

  const model = provider.manifest.models?.find((m) => m.name === modelName || m.model_id === modelName);
  if (!model) throw new Error(`model "${modelName}" is not configured on provider "${providerName}"`);

  // A hosted provider has no base_url in the manifest; only a custom/local one
  // can be called directly like this.
  //
  // LLM_BASE_URL overrides whatever TrueForge has registered. That exists
  // because a provider URL can point at a proxy that quietly breaks structured
  // output: the one in front of this setup accepts `response_format`, forwards
  // the request without it, and returns prose with finish_reason "stop" — no
  // error, just a schema that was never applied (and intermittent 503s when its
  // own upstream is unreachable). Pointing straight at the upstream endpoint
  // makes the identical request return valid JSON.
  const baseUrl = process.env.LLM_BASE_URL ?? provider.manifest.base_url;
  if (!baseUrl) {
    throw new Error(
      `provider "${providerName}" has no base_url — direct calls only work for a custom/local OpenAI-compatible endpoint`,
    );
  }

  // TrueForge redacts the stored key when it serves settings, so a provider
  // that genuinely needs one has to supply it here.
  const stored = provider.manifest.auth?.api_key;
  const apiKey = process.env.LLM_API_KEY ?? (stored && !stored.includes('REDACTED') ? stored : undefined);

  cached = {
    baseUrl: baseUrl.replace(/\/$/, ''),
    modelId: model.model_id ?? modelName,
    apiKey,
    contextLength: model.properties?.context_length ?? 15_000,
    maxOutputTokens: model.properties?.max_output_tokens ?? 4_096,
  };
  return cached;
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
}

/** Ask the configured model for JSON matching `schema`, and return it parsed. */
export async function askJsonDirect<T>(options: AskOptions): Promise<T> {
  const endpoint = await resolveEndpoint();

  const response = await fetch(`${endpoint.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: endpoint.modelId,
      messages: [
        { role: 'system', content: options.instructions },
        { role: 'user', content: options.prompt },
      ],
      stream: false,
      response_format: {
        type: 'json_schema',
        json_schema: { name: options.schema.name, schema: options.schema.schema, strict: true },
      },
    }),
    // Local models are slow: a dozen classified items is a minute and a half of
    // generation, and cutting that off mid-stream loses the whole batch.
    signal: AbortSignal.timeout(options.timeoutMs ?? 300_000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`model endpoint ${response.status}: ${detail.slice(0, 200)}`);
  }

  const body = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = body.choices?.[0]?.message?.content ?? '';
  if (!content.trim()) throw new Error('model returned an empty response');
  return parseJson<T>(content);
}
