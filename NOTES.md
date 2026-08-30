# Where this is, and what is left

Supersedes the architecture half of `SUMMARY.md`. Written after moving the app off
TrueForge for everything it does at runtime.

## What changed

**Agents are ours now.** `app/server/agents/` holds one file per agent, each a plain
`AgentDefinition` — name, description, instructions, output schema, connectors, effort.
No vendor types anywhere in the shape. The instructions used to live as string constants
inside `pipeline.ts` and were *also* pushed to TrueForge by a provisioning script, which
made the platform the owner of the only part of this product that is genuinely ours.

Re-migration stays a command, not a rewrite: `app/server/agents/trueforge.ts` converts
every definition into a TrueForge `CreateAgentRequest`, and `npm run setup` still pushes
all of them. A second platform is another file next to that one.

**Connectors and inference are config.** `config/connectors.json` and
`config/inference.json`, both gitignored, both with a committed `.example` that is also
the fallback so the app runs without them. `${VAR}` in any value is substituted from the
environment, so no secret is ever written into a config file. `config/channels.json` is
the same for outbound writes.

**MCP is dialled directly.** `app/server/mcp.ts` speaks JSON-RPC over streamable-http.
Every connector was registered with TrueForge as `type: 'remote'` plus a URL — it was
proxying to `localhost` ports the whole time. The probe now distinguishes *unconfigured*
(credential missing) from *down* (dialled, refused), and names the cause:
`fetch failed (ECONNREFUSED)` instead of a generic failure.

**Every model call is recorded.** `app/server/agents/runtime.ts` wraps each call, records
agent, scan, stage, note, duration, prompt/result size, and the failure in its own words,
and publishes it over SSE. The `agents` button in the dashboard header shows all ten
agents grouped by whether the pipeline fires them, each with run count, failure count,
median duration and last error — plus a live feed of runs as they land.

The distinction that matters and that no dashboard panel could previously express: an
agent that has never run, one that ran and failed, and one that works but takes ninety
seconds are three different problems.

**Everything fetched is cached.** `app/server/cache.ts`, on disk under `data/cache/`,
keyed by exactly what was asked for. Search is cached 6h, page content 7d. Failures are
never cached — remembering a 429 for six hours turns a blip into an outage. Verified:
a repeated query goes 719ms → 0ms. `CACHE=off` bypasses it; `scripts/cache-check.ts`
re-verifies it.

**GitHub files real tickets.** `app/server/channels/github.ts`. The issue is the audit
record, not a hand-off: it opens with the public complaint and who raised it, states
plainly whether the reporter has been contacted and whether they have confirmed the fix,
and every later step of the loop is appended as a comment carrying the verbatim message.
"Did anyone actually tell the user?" is answerable afterwards only if it is written down
as it happens.

## What is still to do

### 1. The demo fixture is still partly synthetic

`src/demo.ts` seeds scan `demo0001`. Its retrieval half is real; its scores, issues,
abuse findings and migrations are not.

Two problems independent of that, both worth fixing regardless:

- The file's own header claims the company is labelled `(demo)` and that the verdict
  opens by saying the scores are illustrative. Neither is true in the code —
  `demo.ts:569` is `company: source.company`, so it renders as plain "lovable".
- It is written into the same `data/scans.json` as real runs with `createdAt: now`, and
  `store.list()` collapses to one entry per company, newest first. So it **shadows every
  real lovable scan in the sidebar**, and it is the only fully-populated scan in the
  store. Right now it is indistinguishable from a real result.

### 2. Two panels have no producer at all

`topics` and `migrations` are only ever set by `demo.ts`; `index.ts:116` initialises both
to `[]` and nothing else writes them.

Both are genuinely buildable from data already collected, and neither needs an agent loop:

- **Topic volume over time.** UGC carries timestamps and `search.ts` already parses them
  into `SearchHit.date`; the buzz agent already returns `themes[]` per mention. Topic
  volume is those two grouped — theme × month bucket — over mentions that already exist.
  No new retrieval, no new model call.
- **Migrations.** Needs its own deterministic search pass for switching language
  ("switched from X to", "migrated off", "moved from") plus one classification agent over
  the fetched text for direction, reason and confidence. This is a new stage and a new
  agent definition.

### 3. Outbound write channels — each is a separate headache

Declared in `config/channels.json` and shown in the UI with what each is actually blocked
on, rather than as buttons that silently do nothing.

| channel | state | what it actually needs |
|---|---|---|
| GitHub | **implemented** | a `GITHUB_TOKEN` with Issues: read and write, and owner/repo in the config |
| Email | planned | a sending domain with SPF/DKIM behind Mailgun or equivalent. A deliverability project before it is a code project — cold mail from a fresh domain lands in spam |
| Reddit | planned | credentials are already in `.env` (currently empty). The work is the OAuth script-app flow, plus the fact that a new account replying about a product reads as astroturfing and gets shadowbanned. Needs an aged account and per-subreddit self-promotion rules respected |
| Hacker News | planned | no write API — a logged-in session and a form post. Mechanically the easiest. HN is unusually hostile to corporate voice, so the reply has to read as a person |
| X | planned | OAuth 2.0 user context rather than the app-only bearer used for reading, and a paid tier for write access |

Drafting and sending stay separate calls everywhere. Nothing sends unless the request
explicitly says to.

### 4. Loose ends

- `src/client.ts`, `src/hello.ts`, `src/run-agent.ts` and `src/setup.ts` are the only
  remaining TrueForge code, and all of it is the export path. Nothing in a scan touches it.
- The MCP containers in `compose.yml` are not running; `brave`, `discord` and `linkedin`
  probe as down. Brave *search* still works because `search.ts` calls Brave's own HTTPS
  API directly rather than the container.
- `SettingsPanel.tsx` still describes connectors as "TrueForge MCP servers" and models the
  old `needs-auth` status. It needs updating to the new `unconfigured`/`down` states and to
  show the write channels from `/api/channels`.
