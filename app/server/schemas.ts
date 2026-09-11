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
  enum: ['reddit', 'hackernews', 'x', 'github', 'youtube', 'discord', 'linkedin', 'telegram', 'signal', 'whatsapp', 'blog', 'forum', 'review', 'other'],
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

/** The latest things to surface about a company, newest first — a live feed of
 *  new videos, comments and posts pulled straight from the search connectors. */
export const feedSchema = {
  name: 'feed',
  schema: {
    type: 'object',
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['venue', 'kind', 'headline', 'url', 'snippet'],
          properties: {
            venue,
            kind: { type: 'string', enum: ['video', 'comment', 'post'], description: 'A video upload, a comment on a thread/video, or a post' },
            headline: { type: 'string', description: 'Video title, or the post/thread title' },
            url: { type: 'string', description: 'Direct link back to the video, comment or post' },
            date: { type: ['string', 'null'], description: 'ISO 8601 date of the upload, post or comment' },
            author: { type: ['string', 'null'], description: 'Channel name, username, or commenter' },
            snippet: { type: 'string', description: 'The actual comment text when kind is comment (verbatim); otherwise the excerpt shown' },
            engagement: { type: ['number', 'null'], description: 'Views, likes, upvotes or comment count' },
          },
        },
      },
    },
  },
};

/** A company's footprint: every official and third-party channel the sweep found
 *  (subreddits, messaging groups, review pages, social accounts). */
export const profilesSchema = {
  name: 'profiles',
  schema: {
    type: 'object',
    required: ['profiles'],
    properties: {
      profiles: {
        type: 'array',
        items: {
          type: 'object',
          required: ['platform', 'handle', 'url', 'official'],
          properties: {
            platform: { type: 'string', description: 'reddit, telegram, signal, whatsapp, trustpilot, google-reviews, yelp, facebook, instagram, tiktok, snapchat, x, youtube, github, discord, blog, forum, or other' },
            handle: { type: 'string', description: 'The @handle, subreddit name, group name, or page title' },
            url: { type: 'string' },
            official: { type: 'boolean', description: 'True when the company itself runs it; false for fan/community/review/third-party channels' },
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
          // Keyed by index, not by URL.
          //
          // Copying a URL back is the single most expensive thing this schema
          // can ask for and buys nothing: a Reddit permalink is ninety
          // characters of transcription per item, in both the prompt and the
          // reply, and one mistyped character silently loses that item's score.
          // The topics schema learned this already; buzz did not, and it is why
          // batches of eight were overflowing the output cap while batches of
          // four barely fit.
          required: ['index', 'sentiment', 'score'],
          properties: {
            index: { type: 'integer', description: 'The index number the item was given' },
            sentiment: { type: 'string', enum: ['positive', 'mixed', 'neutral', 'negative'] },
            score: {
              type: 'number',
              // strictify() strips `minimum`/`maximum` (OpenAI strict mode
              // rejects them), so the description is the only place the range
              // survives into the request. Local models in particular will
              // happily return 7 on a -1..1 scale without it — and a 7 clamps
              // to +1, turning a neutral mention into a delighted one.
              description: 'Sentiment from -1.0 (hostile) to 1.0 (delighted), a decimal in that range. Never a 0-10 or percentage score.',
            },
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

/** Just the verdict, for the pass that writes it over the finished corpus. */
export const topicsSchema = {
  name: 'topics',
  schema: {
    type: 'object',
    required: ['topics'],
    properties: {
      topics: {
        type: 'array',
        description: 'The canonical topics, most discussed first',
        items: {
          type: 'object',
          required: ['name', 'members'],
          properties: {
            name: { type: 'string', description: 'Two or three words naming the subject' },
            members: {
              type: 'array',
              description: 'The index numbers of every listed theme belonging to this topic',
              items: { type: 'integer' },
            },
          },
        },
      },
    },
  },
} as const;

/** Switching claims read out of already-collected discussion.
 *
 *  The post is referred to by index rather than by URL for the same reason the
 *  topics schema does: a copied URL is the slowest possible thing for a local
 *  model to emit and the easiest to get subtly wrong, and a wrong index can be
 *  discarded where a wrong URL would silently attribute a stranger's words to
 *  the wrong post. */
export const migrationsSchema = {
  name: 'migrations',
  schema: {
    type: 'object',
    required: ['migrations'],
    properties: {
      migrations: {
        type: 'array',
        description: 'Only the posts that really are switching claims. May be empty.',
        items: {
          type: 'object',
          required: ['index', 'direction', 'competitor', 'quote', 'reason', 'confidence'],
          properties: {
            index: { type: 'integer', description: 'The index number of the post this came from' },
            direction: {
              type: 'string',
              enum: ['inbound', 'outbound'],
              description: 'inbound: they moved TO the named product. outbound: they moved AWAY from it.',
            },
            competitor: { type: 'string', description: 'The other product, named as the author names it' },
            quote: { type: 'string', description: "The author's own sentence establishing the move, copied exactly" },
            reason: { type: 'string', description: 'Why they moved, in a few words. Empty string if unstated.' },
            confidence: { type: 'string', enum: ['high', 'low'] },
          },
        },
      },
    },
  },
} as const;

/** Whether each item reports a fault. Index-keyed for the same reason the
 *  topics schema is: copying text back is slow and the copy is never exact. */
export const feedQualitySchema = {
  name: 'feed_quality',
  schema: {
    type: 'object',
    required: ['verdict'],
    properties: {
      verdict: {
        type: 'array',
        items: {
          type: 'object',
          // Quote first, as everywhere else here: a verdict generated before
          // its evidence is a guess the model then justifies.
          required: ['index', 'quote', 'isDatapoint'],
          properties: {
            index: { type: 'integer', description: 'The index of the item being judged' },
            quote: {
              type: 'string',
              description:
                'The words from the item that say something specific about the product, copied '
                + 'exactly. Empty string when there are none.',
            },
            isDatapoint: {
              type: 'boolean',
              description: 'True when somebody said something specific about the product',
            },
          },
        },
      },
    },
  },
} as const;

export const subjectMatchSchema = {
  name: 'subject_match',
  schema: {
    type: 'object',
    required: ['verdict'],
    properties: {
      verdict: {
        type: 'array',
        items: {
          type: 'object',
          // Order is the point, again. `topic` is required before `same` so the
          // model says what the item is about on its own terms BEFORE it is
          // asked to compare that with the subject. Asked the other way round
          // it has been handed the conclusion and goes looking for a way to
          // agree — which is how a Helldivers thread about the Bolt Pistol
          // becomes a bolt.new complaint.
          required: ['index', 'topic', 'same'],
          properties: {
            index: { type: 'integer', description: 'The index of the item being judged' },
            topic: {
              type: 'string',
              description:
                'What this item is about, in a few words, described without reference to the '
                + 'subject you were given. Name the actual thing being discussed.',
            },
            same: {
              type: 'boolean',
              description: 'True when the topic you just described is the same thing as the subject',
            },
          },
        },
      },
    },
  },
} as const;

export const complaintsSchema = {
  name: 'complaints',
  schema: {
    type: 'object',
    required: ['verdict'],
    properties: {
      verdict: {
        type: 'array',
        items: {
          type: 'object',
          // Order is the point. `evidence` is required before `isProblem` so
          // the quote is generated before the judgement rather than after it —
          // a verdict produced first is a guess the model then rationalises,
          // which is how a release announcement gets called a complaint.
          required: ['index', 'evidence', 'isProblem'],
          properties: {
            index: { type: 'integer', description: 'The index of the item being judged' },
            evidence: {
              type: 'string',
              description:
                'The words from the item, copied exactly, that show something is wrong. '
                + 'Empty string when there are none.',
            },
            isProblem: { type: 'boolean', description: 'True when it reports something wrong with the software' },
          },
        },
      },
    },
  },
} as const;

export const diagnoseSchema = {
  name: 'diagnosis',
  schema: {
    type: 'object',
    required: ['verdict', 'confidence', 'reasoning', 'suspectFiles', 'likelyCause', 'proposedFix', 'regressionTest', 'unknowns'],
    properties: {
      verdict: {
        type: 'string',
        description: 'located = the defect is identifiable in the code shown; plausible = consistent with it but not pinned; insufficient = the code shown does not cover it; not-a-defect = the report describes intended behaviour',
        enum: ['located', 'plausible', 'insufficient', 'not-a-defect'],
      },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      reasoning: { type: 'string', description: 'How the conclusion follows from the code shown' },
      suspectFiles: {
        type: 'array',
        description: 'Files to look at, most likely first',
        items: {
          type: 'object',
          required: ['path', 'why'],
          properties: {
            path: { type: 'string' },
            why: { type: 'string', description: 'What in this file relates to the report' },
          },
        },
      },
      likelyCause: { type: 'string', description: 'The defect in one or two sentences, or why it cannot be determined' },
      proposedFix: { type: 'string', description: 'What change would address it, concretely' },
      regressionTest: { type: 'string', description: 'The test that should exist, named for what it asserts' },
      unknowns: {
        type: 'array',
        description: 'What could not be established from the code provided',
        items: { type: 'string' },
      },
    },
  },
} as const;

/** A test that demonstrates the defect, and nothing else.
 *
 *  Deliberately narrower than `fixSchema`: there is no `edits` field, so a
 *  reproduction physically cannot change the code it is supposed to be failing
 *  against. A run that may rewrite the source is a run whose red-then-green
 *  result proves nothing about the defect.
 *
 *  `expectedFailure` is the part that makes a bad attempt detectable. A test
 *  that fails because it imports a module that does not exist also "fails", and
 *  without a stated expectation there is no way to tell that apart from a
 *  demonstration of the bug. */
export const reproduceSchema = {
  name: 'reproduction',
  schema: {
    type: 'object',
    required: ['summary', 'files', 'expectedFailure', 'notes'],
    properties: {
      summary: { type: 'string', description: 'What the test asserts, in one or two sentences' },
      files: {
        type: 'array',
        description: 'Test files to add, in full. Test files only — never a change to the code under test.',
        items: {
          type: 'object',
          required: ['path', 'contents', 'why'],
          properties: {
            path: {
              type: 'string',
              description: "Repo-relative path of a NEW test file, inside the project's existing test directory and matching its naming convention",
            },
            contents: { type: 'string' },
            why: { type: 'string', description: 'What this file demonstrates' },
          },
        },
      },
      expectedFailure: {
        type: 'string',
        description: 'The assertion you expect to fail against the current code, and roughly what the failure output will say. Used to check the test failed for the reported reason rather than because it could not run.',
      },
      notes: {
        type: 'string',
        description: 'Anything the reader should know. If the defect cannot be demonstrated from what you were shown, return no files and say why here.',
      },
    },
  },
} as const;

export const fixSchema = {
  name: 'fix',
  schema: {
    type: 'object',
    required: ['summary', 'edits', 'newFiles', 'notes'],
    properties: {
      summary: { type: 'string', description: 'What this change does, one or two sentences' },
      edits: {
        type: 'array',
        description: 'Targeted replacements in existing files. Prefer these over new files.',
        items: {
          type: 'object',
          required: ['path', 'find', 'replace', 'why'],
          properties: {
            path: { type: 'string', description: 'Repo-relative path of an existing file' },
            find: {
              type: 'string',
              description: 'The exact text to replace, copied character for character from the file. Must appear exactly once.',
            },
            replace: { type: 'string', description: 'What to put in its place' },
            why: { type: 'string' },
          },
        },
      },
      newFiles: {
        type: 'array',
        description: 'Files that do not exist yet, in full. Use only when there is nowhere to edit.',
        items: {
          type: 'object',
          required: ['path', 'contents', 'why'],
          properties: {
            path: { type: 'string' },
            contents: { type: 'string' },
            why: { type: 'string' },
          },
        },
      },
      notes: { type: 'string', description: 'Anything the reviewer should know, including what was not changed' },
    },
  },
} as const;

export const subjectSchema = {
  name: 'subject',
  schema: {
    type: 'object',
    required: ['name', 'searchTerm', 'aliases', 'excludeTerms', 'site', 'repo', 'kind', 'summary', 'confidence'],
    properties: {
      name: { type: 'string', description: 'What to call it on screen — the name its own users use' },
      searchTerm: { type: 'string', description: 'The single best term to search the web for' },
      aliases: {
        type: 'array',
        description: 'Other names the same thing is discussed under. Empty if there are none.',
        items: { type: 'string' },
      },
      excludeTerms: {
        type: 'array',
        description: 'Unrelated things that share the name and would pollute a search — people, other products, ordinary words',
        items: { type: 'string' },
      },
      site: { type: 'string', description: 'Its homepage, or empty string if unknown' },
      repo: { type: 'string', description: 'Its source repository, or empty string if unknown' },
      kind: {
        type: 'string',
        enum: ['open-source project', 'commercial product', 'company', 'service', 'unknown'],
      },
      summary: { type: 'string', description: 'One sentence: what it is' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    },
  },
} as const;

export const crawlSchema = {
  name: 'crawl',
  schema: {
    type: 'object',
    required: ['profiles', 'visit', 'done', 'notes'],
    properties: {
      profiles: {
        type: 'array',
        description: 'Accounts and communities found on the pages seen so far',
        items: {
          type: 'object',
          required: ['platform', 'handle', 'url', 'official'],
          properties: {
            platform: { type: 'string', description: 'reddit, x, github, discord, youtube, linkedin, mastodon, …' },
            handle: { type: 'string' },
            url: { type: 'string' },
            official: { type: 'boolean', description: 'Run by the company itself rather than by a community or third party' },
          },
        },
      },
      visit: {
        type: 'array',
        description: 'Pages on this site worth opening next to find more, copied exactly from the links given. Empty when there is nothing left worth opening.',
        items: { type: 'string' },
      },
      done: { type: 'boolean', description: 'True when opening more pages of this site would not find anything new' },
      notes: { type: 'string', description: 'Anything odd — a bot check, a parked domain, the wrong company, an unusual place the links live' },
    },
  },
} as const;

export const verdictSchema = {
  name: 'verdict',
  schema: {
    type: 'object',
    required: ['verdict'],
    properties: {
      verdict: {
        type: 'string',
        description: 'One paragraph: which way perception is moving across the whole window, and what is driving it.',
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
          required: ['title', 'kind', 'severity', 'summary', 'impact', 'check', 'evidence', 'draftReply'],
          properties: {
            title: { type: 'string', description: 'Imperative and specific, as an issue title' },
            kind: {
              type: 'string',
              enum: ['bug', 'ux', 'performance', 'docs', 'billing', 'reliability', 'feature-gap'],
            },
            severity: { type: 'string', enum: ['critical', 'serious', 'warning', 'good'] },
            summary: { type: 'string' },
            impact: {
              type: 'string',
              description:
                'The observable consequence: what stops working, for whom, under what conditions. '
                + 'A statement of fact about the product, not a quote and not a verdict.',
            },
            check: {
              type: 'string',
              description:
                'How to tell whether this is real, and later whether it is fixed. Concrete steps '
                + 'and the observation that decides it. Exactly "cannot be derived from the '
                + 'evidence" when the reports do not say enough to build one.',
            },
            evidence: {
              type: 'array',
              items: { type: 'integer' },
              // Index numbers, not URLs. Asking a model to copy a URL back is
              // asking it to transcribe ninety characters of Reddit permalink
              // exactly, and a single altered character produces an id that
              // resolves to nothing — so the issue renders with no readable
              // source and looks unsupported. An index is one token, and a
              // wrong one is out of range and can be discarded loudly instead
              // of quietly mis-attributing somebody's complaint.
              description: 'Index numbers of the items that back this up',
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

/** Resolve a company name to a homepage URL. */
export const rescueSchema = {
  name: 'rescue',
  schema: {
    type: 'object',
    required: ['value', 'confident', 'why'],
    properties: {
      value: {
        type: 'string',
        description:
          'The value alone, in the form asked for. Empty string when it cannot be supplied.',
      },
      confident: {
        type: 'boolean',
        description:
          'False when the answer would be a constructed guess rather than something known. A '
          + 'plausible URL for a thing that does not exist is worse than no answer.',
      },
      why: { type: 'string', description: 'One short line: how this was arrived at, or why not.' },
    },
  },
};

export const siteSchema = {
  name: 'site',
  schema: {
    type: 'object',
    required: ['url'],
    properties: {
      url: { type: 'string', description: 'The company homepage URL, https://' },
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

/* ------------------------------------------------------- loop agents ---- */

/** A real engineering ticket, written from a public complaint.
 *
 *  Deliberately more than a restatement of the issue: a ticket someone can
 *  pick up needs steps, an expected/actual pair, and a way to know when it is
 *  done. Those are the fields an engineer would otherwise have to reconstruct
 *  from the thread themselves. */
export const ticketSchema = {
  name: 'ticket',
  schema: {
    type: 'object',
    required: ['title', 'body', 'labels', 'reproSteps', 'expected', 'actual', 'acceptance'],
    properties: {
      title: {
        type: 'string',
        description: 'Imperative and specific, as an engineer would write it. No marketing tone, no severity prefix.',
      },
      body: {
        type: 'string',
        description: 'Markdown. What is wrong, who hit it, and why it matters. Do not repeat the fields below.',
      },
      labels: { type: 'array', items: { type: 'string' } },
      reproSteps: {
        type: 'array',
        items: { type: 'string' },
        description: 'Ordered steps taken from what the reporters actually described. Never invent a step they did not mention.',
      },
      expected: { type: 'string' },
      actual: { type: 'string' },
      acceptance: {
        type: 'array',
        items: { type: 'string' },
        description: 'Checkable conditions that mean this is fixed, including the regression test that should exist.',
      },
    },
  },
};

/** A reply addressed to the person who reported something.
 *
 *  Split into the message and the reasoning behind it so a human reviewing the
 *  queue can judge the tone before it goes out, rather than after. */
export const replySchema = {
  name: 'reply',
  schema: {
    type: 'object',
    required: ['message', 'tone', 'addresses'],
    properties: {
      message: {
        type: 'string',
        description:
          'The reply itself, in the register of the venue it is going to. Plain, specific, no corporate filler, '
          + 'no promises about dates. Acknowledge the particular thing they hit, in their terms.',
      },
      tone: {
        type: 'string',
        description: 'One line on the register chosen and why it fits this venue and this person.',
      },
      addresses: {
        type: 'array',
        items: { type: 'string' },
        description: 'The specific points from their message this reply answers.',
      },
    },
  },
};
