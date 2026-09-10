# Whisperer

Listens to what the internet says about a company, and turns the complaints into
issues you can actually file.

Give it a company name. It reads their site for every account they run, searches
Reddit, Hacker News and the wider web for what people said about them, draws how
opinion moved over time, and separates the grumbling from the real defects — each
one with the threads that back it up, a draft reply to the people who raised it,
and a payload ready for Linear, Jira or GitHub. It also sweeps for people abusing
the brand's name: impersonation, phishing, fake support, scams.

It runs entirely against a local [TrueForge](https://trueforge.dev) instance, and
keeps every run — this is a dashboard of scanned sites, not a one-shot report.

## Layout

```
src/                 TrueForge control plane — one file describes what this instance has
  registry.ts          every MCP connector and skill, as data; missing credentials skip themselves
  setup.ts             applies the registry (idempotent) and health-checks each connector
  run-agent.ts          a CLI for one agent turn, with the tool-approval loop
  client.ts / hello.ts  the smallest possible streaming turn
app/
  shared/types.ts      the shapes the API and the dashboard agree on
  server/               BFF: runs the five-stage scan, streams progress, builds tracker payloads
    pipeline.ts           the agent calls: presence, discovery, buzz, health, abuse
    schemas.ts             JSON schemas each turn is held to, normalized for OpenAI strict mode
    store.ts               scans persisted to data/scans.json — the run history
    trackers.ts             builds the Linear/Jira/GitHub filing payload for one issue
    index.ts                Express routes + the SSE stream
  web/                  the dashboard (Vite + React)
skills/               the two skills authored here, mirrored to github.com/kristopolous/hackieskills
docker/               Dockerfiles for the MCP servers that ship stdio-only
compose.yml           the local MCP servers, all on network_mode: host
data/scans.json       persisted run history
```

## Getting it running

**1. TrueForge itself.**

```bash
npx @truefoundry/trueforge@latest        # http://localhost:8790
```

Add a model under Settings → Models — an OpenAI, Anthropic or similar model with
a large context window. The pipeline makes five agent calls per scan with large
tool schemas in context; a small local model (the default `ollama/qwen-3-8`,
15k context) is too small and will time out. This instance runs
`openai/gpt-5-5` — set `TRUEFORGE_MODEL` to whatever you've configured.

**2. Credentials.** `cp .env.example .env` and fill in what you want. Everything
is optional; a connector whose credential is missing is simply not registered.

**3. The MCP servers.**

```bash
docker compose --env-file .env up -d reddit-mcp hn-mcp linkedin-mcp
```

Then whichever of the rest you have accounts for — each needs a one-time
interactive login, described in `compose.yml` beside its service. Every service
runs with `network_mode: host`: this machine's Docker bridge has no outbound
route (its `FORWARD` chain came up `policy DROP` with Docker's own rules missing
— `sudo systemctl restart docker` reinstalls them), so a bridged container
registers with TrueForge fine and then fails every search it tries to make.

**4. Register everything with TrueForge.**

```bash
npm run setup
```

Applies `src/registry.ts` and then dials each connector, so a container that is
down or misconfigured shows up here rather than mid-conversation.

**5. The dashboard.**

```bash
npm run dev        # API on :8791, dashboard on :5173
```

## Scripts

| Command | What it does |
|---|---|
| `npm run setup` | Apply `src/registry.ts` to TrueForge and health-check every connector |
| `npm run dev` | Dashboard + API together |
| `npm run api` / `npm run web` | Either half alone |
| `npm run agent -- "prompt"` | One agent turn in the terminal, with tool approvals |
| `npm run hello` | Smallest streaming example — good for checking the connection |
| `npm run typecheck` | `tsc` over everything |

## What's connected

| Connector | Source | Needs |
|---|---|---|
| `reddit` | [jordanburke/reddit-mcp-server](https://github.com/jordanburke/reddit-mcp-server) | nothing (anonymous, ~10 req/min); app credentials raise the limit |
| `hn` | [erithwik/mcp-hn](https://github.com/erithwik/mcp-hn) | nothing — bridged to HTTP with supergateway, `mcp-hn` pinned to `mcp[cli]<1.3` (0.1.0 targets the 1.x SDK; 2.x drops `Server.list_tools` and it dies on startup) |
| `linkedin` | [stickerdaniel/linkedin-mcp-server](https://github.com/stickerdaniel/linkedin-mcp-server) | a linked browser session (`--login` once) |
| `discord` | [SaseQ/discord-mcp](https://github.com/SaseQ/discord-mcp) | a bot token |
| `x` | [api.x.com/mcp](https://docs.x.com/tools/mcp) | an app-only bearer token |
| `telegram` | [chigwell/telegram-mcp](https://github.com/chigwell/telegram-mcp) | API id/hash and a session string |
| `signal` | [rymurr/signal-mcp](https://github.com/rymurr/signal-mcp) | a signal-cli registered number — bridged with supergateway |
| `whatsapp` | [lharries/whatsapp-mcp](https://github.com/lharries/whatsapp-mcp) | a phone linked by QR — bridged with supergateway |
| `exa` | shipped with TrueForge | nothing — general web search, kept as the fallback |
| `bright-data` | shipped with TrueForge | a Bright Data account — the **preferred** search path (see below) |
| `github` | shipped with TrueForge | nothing |

`hn`, `signal` and `whatsapp` are stdio-only upstream; the Dockerfiles in
`docker/` front them with [supergateway](https://github.com/supercorp-ai/supergateway)
so TrueForge can reach them over HTTP.

| Skill | Source |
|---|---|
| `extract-social-media` | authored here → [kristopolous/hackieskills](https://github.com/kristopolous/hackieskills) |
| `find-discussions` | authored here → same repo |
| `brightdata-brand-listening`, `brightdata-search`, `brightdata-scrape` | [brightdata/skills](https://github.com/brightdata/skills) — 3 of its 21 skills |
| `apple-appstore-reviewer` | [github/awesome-copilot](https://github.com/github/awesome-copilot) |

Skills are pinned to a commit, not a branch, so one can't change underneath a
running agent. They execute in the agent's sandbox, which needs a sandbox
provider configured under Settings → Sandbox providers; until then the dashboard
runs `extract-social-media`'s scripts locally instead of through the sandboxed
skill.

### Search preference

Every stage that searches (site resolution, discovery, the abuse sweep) picks
its connectors in this order: **Bright Data, Reddit, Hacker News, Exa** — see
`SEARCH_PREFERENCE` in `pipeline.ts`. Bright Data is the unmetered, paid path;
the shared Exa MCP endpoint rate-limits (`429`) under sustained use, so it's kept
only as a fallback, never as the primary. A transient failure (429, a dropped
transport, a 5xx) gets one retry per stage before it's allowed to fail the run.

### Reddit via the official API

The Reddit MCP connector is unreliable, so discovery also talks straight to
Reddit's official API with **PRAW** when you give it keys. Paste a script-type
Reddit app's credentials in **Settings** (the masthead → *settings*), and they're
stored on this machine only (`data/settings.json`, mode 0600) and never shown
back or sent to a model. With keys configured, discovery pulls real Reddit
threads through the API and folds them into the results alongside the agent's
own search:

```
python3 -m venv .venv && .venv/bin/pip install praw    # required once
```

A virtualenv rather than `pip install praw`, because a Debian host refuses
installs into its system interpreter (PEP 668) and `--user` is no better. The
server looks for `.venv/bin/python3` beside the checkout and uses it for the
Reddit reader; set `WHISPERER_PYTHON` if the interpreter lives somewhere else.

Without keys, discovery falls back to whatever search connectors are attached.

## How a scan works

Five agent turns, each held to a JSON schema (`app/server/schemas.ts`, run
through `strictify()` for OpenAI's structured-output rules) so the result is
data rather than prose to scrape:

1. **Presence** — render the site with [Lightpanda](https://lightpanda.io) and
   classify its outbound links. Footers are built in JavaScript on most
   marketing sites, so a plain fetch finds nothing; this is the difference
   between four results and zero.
2. **Discovery** — search Reddit and Hacker News directly, Bright Data or Exa
   for everything else, and record what was said with its date and engagement.
   The agent is instructed to keep going when one backend fails rather than
   abandon the whole search.
3. **Buzz** — score each mention from −1 to +1 and write the verdict. The
   arithmetic that follows — bucketing, the volume-weighted mean, the delta —
   is computed in `pipeline.ts`, not asked of the model.
4. **Health** — triage the negative half into merged issues with a severity, the
   threads that back each one, and a reply to the people who raised it.
5. **Abuse / Integrity** — sweep the same discussion plus fresh search for
   impersonation, phishing, fake-support scams, counterfeit and malware trading
   on the brand's name. Runs last: it's the slowest and least likely to find
   anything, and every earlier stage stays useful without it.

Every tool call, its result, and any warning is streamed to the client over SSE
and kept on the scan (`scan.log`), so a finished run can still be read back —
not just watched live.

## Persistence & the run history

Scans are stored as one JSON file (`data/scans.json`) — a database would be
ceremony at this volume. `GET /api/scans` returns every past run (bodies
stripped to headline counts) for the dashboard's run rail; `GET /api/scans/:id`
returns one in full. Every scan survives an API restart.

## Known limits

- **A small model will struggle.** Five turns with tool schemas in context is a
  lot to ask of an 8B model with a 15k window.
- **No tracker actually receives an issue yet.** Filing an issue builds the real
  payload and marks it filed, and says plainly that it did not send. Add the
  Linear, Jira or GitHub connector to `src/registry.ts` to close the loop.
- **Bright Data and the messaging connectors need their own accounts.** Nothing
  above runs until the matching credential lands in `.env`.
