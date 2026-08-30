# Whisperer — handoff summary

Status as of this writing: **not working end-to-end.** Multiple real bugs were found and
fixed this session, but no full scan (all stages, real data, no manual intervention) has
been verified to complete successfully. The last full run was killed mid-stage. Read this
before touching anything — several root causes turned out to be different from what they
looked like on the surface.

## What this is supposed to do

Give it a company name. It:
1. **Presence** — finds every social/community account the company runs.
2. **Discovery** — searches Reddit, HN, and the wider web for third-party discussion.
3. **Feed** — a live stream of the newest videos/comments/posts about the company.
4. **Buzz** — scores sentiment over time, no tools, pure reasoning over the collected corpus.
5. **Health** — triages complaints into issues with a draft reply and a tracker payload.
6. **Integrity/Abuse** — sweeps for impersonation, phishing, scams trading on the brand.

Runs against a local TrueForge instance (`npx @truefoundry/trueforge@latest`, port 8790).

## Architecture (as it stands)

```
src/
  registry.ts     every MCP connector + skill this instance should have, as data
  agents.ts       every pipeline stage saved as a named TrueForge agent (see below)
  setup.ts        applies registry.ts + agents.ts, idempotent, health-checks connectors
app/
  server/
    pipeline.ts   the actual stage logic — now fires SAVED agents by name, not inline specs
    stages.ts     runs one stage, times it, persists it, patches the client
    schemas.ts    JSON schemas each stage's output is held to (OpenAI strict-mode normalized)
    store.ts      scans persisted to data/scans.json
    index.ts      Express + SSE stream
  web/            the dashboard
```

**Important architectural fact discovered mid-session:** the live pipeline does not build
inline agent specs anymore — `askJson()` in `pipeline.ts` calls
`client.sessions.create({ agent: { name: 'whisperer-discovery' } })`, referencing agents
saved in TrueForge via `src/agents.ts`. **This means editing an instruction string or
schema in `pipeline.ts` does nothing at runtime until `npm run setup` is re-run** — it
only takes effect once pushed to the saved agent. This bit me more than once this session;
it will bite the next agent too if they forget it.

## Real bugs found and fixed this session

1. **`preload: true` on every MCP server, everywhere.** TrueForge defaults to
   `preload: false` (deferred tool discovery) specifically because eager preload does
   `Promise.all(listTools())` across every attached server at turn start with no
   per-server try/catch — one broken connector (e.g. an unauthenticated Bright Data) took
   down the *entire turn* before the model got to do anything. Fixed by setting
   `preload: false` on every search-capable agent in `src/agents.ts`. Verified this
   specific failure mode is gone (confirmed via direct testing against TrueForge's own
   source in `/home/chris/hacks/20260829/trueforge`).

2. **`parallelToolCalls` defaulting to on.** The model was firing multiple search calls
   in the same turn simultaneously. Brave's own MCP server enforces a hard `perSecond: 1`
   limit (confirmed in its source, `brave-search-mcp-server/src/constants.ts`) — a burst
   of parallel calls 429s almost everything past the first. Fixed by setting
   `parallelToolCalls: false` in the `searchAgent()` builder in `src/agents.ts`, forcing
   serial tool calls. **Partially verified**: a rerun after this fix showed isolated
   single 429s instead of bursts of 5+, but was not watched to full completion.

3. **Duplicate/garbled Presence entries** (`@@supabase`, three YouTube rows for one
   channel). Two separate causes:
   - `Presence.tsx` blindly rendered `@{p.handle}` even when the model's handle already
     had a leading `@`. Fixed: strip leading `@`s before rendering.
   - Dedup was keyed on a raw lowercased URL, which doesn't catch `twitter.com` vs `x.com`
     or YouTube's `/c/`, `/channel/`, `/@`, bare-name URL variants for the same channel.
     Added `canonicalProfileKey()` in `pipeline.ts` that aliases hosts and collapses
     YouTube's path variants before the dedup map key is built. **Verified against real
     data**: pulled the actual stored profiles from a completed scan (`data/scans.json`,
     scan `6916ee4e`) and confirmed no exact duplicates remain. What *may* still read as
     "duplicate garbage" to a human: several near-identical LinkedIn regional/community
     pages and ~8 marketplace/directory listings (SourceForge, AWS Marketplace, Capterra,
     G2, StackShare...) that are technically distinct URLs but are noise relative to
     "find their social handles." That noise came from the agentic sweep — see #4.

4. **Presence took "30 minutes to do the equivalent of a single Google search."** This was
   the real complaint, and it's an architecture problem, not a bug: `findPresence` ran a
   fast deterministic site-scrape (`skills/extract-social-media`, seconds) and then
   *unconditionally* also ran a slow agentic multi-tool-call web sweep
   (`whisperer-footprint`) before returning anything, and that sweep is what generated the
   marketplace-listing noise in #3. **Cut, not tuned**: `findPresence` now returns only the
   fast deterministic scrape. `whisperer-footprint` is still a saved TrueForge agent if a
   deeper manual sweep is ever wanted, just no longer called from the default pipeline.
   **Not yet verified end-to-end after this change** — the process was killed to write
   this file instead.

5. **A third, parallel Reddit path.** `findMentions` was *also* calling a PRAW
   (official Reddit API) integration via `reddit.ts`/`settings.ts` in addition to the MCP
   `reddit` connector and whatever the agent found via web search — three separate reddit
   code paths feeding one result. Removed the PRAW call from `findMentions` per explicit
   instruction ("fuck the reddit mcp... we can do all of it through bright data"). `reddit
   .ts`/`settings.ts` still exist and are still wired into a Settings-panel "test
   connection" button, but no longer feed scan results.

6. **The `reddit`/`hn` MCP connectors were removed from every search stage's wanted-server
   list** (`SEARCH_PREFERENCE`, `PRESENCE_SERVERS`, `DISCOVERY_SERVERS`, `FEED_SERVERS`,
   `ABUSE_SERVERS` in `pipeline.ts`) per the same instruction — Reddit's own anonymous-
   request block (`"Reddit is blocking unauthenticated requests from this network"`) and
   Hacker News Algolia intermittently 500ing made the dedicated MCP servers a liability.
   Bright Data, Brave, and Exa cover the same ground now (`site:reddit.com`,
   `site:news.ycombinator.com` queries + scrape). The `reddit-mcp`/`hn-mcp` **containers
   are still running** — nothing currently calls them, they're just idle.

## Known-broken / not investigated

- **`discord-mcp`'s Docker healthcheck is itself broken**: `docker inspect` shows
  `unhealthy`, but the actual failure is `exec: "curl": executable file not found in
  $PATH` inside the container — the healthcheck command is wrong, not the service (it was
  verified working end-to-end earlier in the session, 75 tools, real profile fetch). Fix:
  swap the `curl`-based healthcheck in `compose.yml` for `wget` or a raw TCP probe, or
  confirm what's actually in that image.
- **No full scan has completed with the current code.** Every verification run this
  session was either killed for a fix, crashed on a since-fixed bug, or wasn't watched to
  the end. The last confirmed-good data point is the Presence stage alone (40 channels,
  clean dedup, ~seconds — see bug #4 above for why that's now the *only* thing Presence
  does).
- **Multiple stale server processes repeatedly caused false signals this session.**
  `npm run api` uses `tsx --watch`; several times a *second* process (started without
  `--watch`, or left over from an earlier turn) held port 8791 and served stale code while
  a `--watch` process sat idle, or vice versa. **Before debugging any "it's still broken"
  report, run `pgrep -af "app/server/index.ts"` and kill everything, then start exactly
  one instance.** This wasted significant time this session and is likely to happen again.
- **Something else was editing this repo concurrently, at least twice this session** —
  files changed on disk between reads with no action taken by this agent (new components
  appeared, `git init` happened, agent architecture was refactored to the saved-agent
  pattern). Never confirmed who/what. If the next agent sees files that don't match this
  document, that's why — re-read before assuming staleness.
- **`ollama/qwen-3-8` (the TrueForge default model) cannot run this pipeline** — 15k
  context, 4k output, and multiple tool-heavy turns. `TRUEFORGE_MODEL=openai/gpt-5-5` is
  what this session used throughout.

## Honest architectural take

The multi-stage, agent-fires-tools-and-reasons design is a mismatch for at least the
Presence stage (fixed — see #4) and is worth questioning for Discovery and Feed too:
routing "search Reddit and Hacker News for mentions" through an LLM tool-calling loop
costs real minutes and several points of failure (rate limits, deferred-tool round trips,
model flakiness in emitting valid structured output) for something that is, underneath,
a handful of HTTP requests and some text classification. A faster, more reliable shape for
this whole product would likely be: **deterministic code does the fetching (direct API
calls or Bright Data's scrape endpoint, no agent loop), and the LLM is used once, at the
end, purely for classification/sentiment/triage over already-fetched text** — not for
deciding which tools to call and when. That's a bigger rewrite than this session had time
for, but it is very likely the actual fix, not another round of instruction-tuning or
rate-limit patching on the current agentic design.

## Where things are right now

- API server: **not running** (killed to write this file). `npm run api` to start it.
- Docker containers up: `discord-mcp` (unhealthy per broken healthcheck, actually fine),
  `brave-mcp`, `hn-mcp` (unused), `linkedin-mcp`, `reddit-mcp` (unused).
- `.env` has real credentials for: Discord, LinkedIn (session cookie, logged in as the
  real user), Brave (`<redacted — see .env>`), OpenAI (via TrueForge).
  **`.env` is gitignored and confirmed never committed** — verified this explicitly with
  `git check-ignore`, `git ls-files`, and a full grep of every tracked file for
  token-shaped strings.
- 7 saved TrueForge agents exist (`whisperer-site/footprint/discovery/feed/buzz/health/
  abuse`) and reflect the latest instruction/config changes as of the last `npm run setup`
  run in this session.
