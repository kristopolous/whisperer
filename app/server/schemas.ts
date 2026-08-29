/** JSON Schemas the agent's responses are held to.
 *
 * These are passed as `responseFormat: { type: 'json_schema', jsonSchema }` on the
 * agent spec, so a turn returns parseable data instead of prose we'd have to
 * scrape. Keep them in step with app/shared/types.ts.
 *
 * Everything here goes through `strictify` on the way out. OpenAI's structured
 * outputs reject a schema that omits `additionalProperties: false`, that leaves a
 * property out of `required`, or that carries validation keywords it doesn't
 * implement — so the schemas below are written for readability and normalized
 * once, rather than hand-maintained against one provider's rules.
 */

/** Keywords OpenAI's structured outputs reject outright. */
const UNSUPPORTED = new Set(['minimum', 'maximum', 'minItems', 'maxItems', 'default', 'format', 'pattern']);

type Node = Record<string, unknown>;

export function strictify<T>(schema: T): T {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;

    const out: Node = {};
    for (const [key, value] of Object.entries(node as Node)) {
      if (UNSUPPORTED.has(key)) continue;
      out[key] = walk(value);
    }

    if (out.type === 'object' && out.properties) {
      out.additionalProperties = false;
      // Strict mode has no notion of an optional key: every property must be
      // required, and anything genuinely absent is expressed as a null type.
      out.required = Object.keys(out.properties as Node);
    }
    return out;
  };
  const normalized = walk(schema) as Node;
  // The schema is compliant once normalized, so ask the provider to enforce it
  // rather than treat it as a hint.
  if (normalized.schema) normalized.strict = true;
  return normalized as T;
}

const venue = {
  type: 'string',
  enum: ['reddit', 'hackernews', 'x', 'github', 'youtube', 'blog', 'forum', 'review', 'other'],
} as const;

export const mentionsSchema = {
  name: 'mentions',
  schema: {
    type: 'object',
    required: ['mentions'],
    properties: {
      mentions: {
        type: 'array',
        items: {
          type: 'object',
          required: ['venue', 'title', 'url', 'excerpt'],
          properties: {
            venue,
            title: { type: 'string' },
            url: { type: 'string' },
            date: { type: ['string', 'null'], description: 'ISO 8601 date of the post or comment' },
            author: { type: ['string', 'null'] },
            excerpt: { type: 'string', description: 'What was actually said, quoted or closely paraphrased' },
            engagement: { type: ['number', 'null'], description: 'Points, upvotes or comment count' },
          },
        },
      },
    },
  },
};

export const buzzSchema = {
  name: 'buzz',
  schema: {
    type: 'object',
    required: ['scored', 'verdict'],
    properties: {
      scored: {
        type: 'array',
        items: {
          type: 'object',
          required: ['url', 'sentiment', 'score'],
          properties: {
            url: { type: 'string' },
            sentiment: { type: 'string', enum: ['positive', 'mixed', 'neutral', 'negative'] },
            score: { type: 'number', minimum: -1, maximum: 1 },
            themes: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      verdict: {
        type: 'string',
        description: 'One paragraph: which way perception is moving, and what is driving it.',
      },
    },
  },
};

export const healthSchema = {
  name: 'health',
  schema: {
    type: 'object',
    required: ['issues'],
    properties: {
      issues: {
        type: 'array',
        items: {
          type: 'object',
          required: ['title', 'kind', 'severity', 'summary', 'impact', 'evidence', 'draftReply'],
          properties: {
            title: { type: 'string', description: 'Imperative and specific, as an issue title' },
            kind: {
              type: 'string',
              enum: ['bug', 'ux', 'performance', 'docs', 'billing', 'reliability', 'feature-gap'],
            },
            severity: { type: 'string', enum: ['critical', 'serious', 'warning', 'good'] },
            summary: { type: 'string' },
            impact: { type: 'string', description: 'What the user hits, in their words' },
            evidence: {
              type: 'array',
              items: { type: 'string' },
              description: 'URLs of the mentions that back this up',
            },
            draftReply: {
              type: 'string',
              description:
                'A reply to the people who raised it: acknowledge the specific problem, say what is being done, no corporate filler, no promises about dates.',
            },
          },
        },
      },
    },
  },
};

export const abuseSchema = {
  name: 'abuse',
  schema: {
    type: 'object',
    required: ['findings'],
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          required: ['kind', 'severity', 'title', 'summary', 'harm', 'locations', 'evidence', 'recommendation'],
          properties: {
            kind: {
              type: 'string',
              enum: ['impersonation', 'phishing', 'scam', 'counterfeit', 'fake-support',
                     'malware', 'spam', 'harassment', 'credential-theft'],
            },
            severity: { type: 'string', enum: ['critical', 'serious', 'warning', 'good'] },
            title: { type: 'string' },
            summary: { type: 'string', description: 'What the operation is doing, concretely' },
            harm: { type: 'string', description: 'Who it hurts and how' },
            locations: {
              type: 'array',
              items: { type: 'string' },
              description: 'The impersonating handle, fake domain, or thread where it operates',
            },
            evidence: { type: 'array', items: { type: 'string' }, description: 'URLs seen' },
            recommendation: {
              type: 'string',
              description: 'The concrete next step: which platform to report to, what to register, who to warn',
            },
          },
        },
      },
    },
  },
};
