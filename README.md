# Whisperer

Listens to what the internet says about a company, and turns the complaints into
issues you can actually file.

Give it a company name. It reads their site for every account they run, searches
Reddit, Hacker News and the wider web for what people said about them, draws how
opinion moved over time, and separates the grumbling from the real defects —
each one with the threads that back it up, a draft reply to the people who
raised it, and a payload ready for Linear, Jira or GitHub.

It runs entirely against a local [TrueForge](https://trueforge.dev) instance.

## Layout

```
src/               TrueForge control plane — one file describes what this instance has
  registry.ts        every MCP connector and skill, as data
  setup.ts           applies the registry (idempotent) and health-checks each connector
  run-agent.ts       a CLI for one agent turn, with the tool-approval loop
  hello.ts           the smallest possible streaming turn
app/
  shared/types.ts    the shapes the API and the dashboard agree on
  server/            BFF: runs the four-stage scan, streams progress, builds tracker payloads
  web/               the dashboard
skills/            the two skills authored here, mirrored to github.com/kristopolous/hackieskills
docker/            Dockerfiles for the MCP servers that ship stdio-only
compose.yml        the local MCP servers
```

## Getting it running

**1. TrueForge itself.**

```bash
npx @truefoundry/trueforge@latest        # http://localhost:8790
```

Add a model under Settings → Models. The pipeline makes four agent calls per scan
with large tool schemas in context, so a small local model will be slow and may
truncate — something with a 100k+ context window is worth it here.

**2. Credentials.** `cp .env.example .env` and fill in what you want. Everything is
optional; a connector whose credential is missing is simply not registered.

**3. The MCP servers.**

```bash
docker compose --env-file .env up -d reddit-mcp hn-mcp linkedin-mcp
```

Then whichever of the rest you have accounts for — each needs a one-time
interactive login, described in `compose.yml` beside its service.

**4. Register everything with TrueForge.**

```bash
npm run setup
```

This applies `src/registry.ts` and then dials each connector, so a container that
is down or misconfigured shows up here rather than mid-conversation.

**5. The dashboard.**

```bash
npm run dev        # API on :8791, dashboard on :5173
```

## Scripts

| Command | What it does |
|---|---|
| `npm run setup` | Apply `src/registry.ts` to TrueForge and health-check every connector |
| `npm run dev` | Dashboard + API together |
| `npm run agent -- "prompt"` | One agent turn in the terminal, with tool approvals |
| `npm run hello` | Smallest streaming example — good for checking the connection |
| `npm run typecheck` | `tsc` over everything |

## What's connected

| Connector | Source | Needs |
|---|---|---|
| `reddit` | [jordanburke/reddit-mcp-server](https://github.com/jordanburke/reddit-mcp-server) | nothing (anonymous, ~10 req/min); app credentials raise the limit |
| `hn` | [erithwik/mcp-hn](https://github.com/erithwik/mcp-hn) | nothing |
| `linkedin` | [stickerdaniel/linkedin-mcp-server](https://github.com/stickerdaniel/linkedin-mcp-server) | a linked browser session (`--login` once) |
| `discord` | [SaseQ/discord-mcp](https://github.com/SaseQ/discord-mcp) | a bot token |
| `x` | [api.x.com/mcp](https://docs.x.com/tools/mcp) | an app-only bearer token |
| `telegram` | [chigwell/telegram-mcp](https://github.com/chigwell/telegram-mcp) | API id/hash and a session string |
| `signal` | [rymurr/signal-mcp](https://github.com/rymurr/signal-mcp) | a signal-cli registered number |
| `whatsapp` | [lharries/whatsapp-mcp](https://github.com/lharries/whatsapp-mcp) | a phone linked by QR |

`hn`, `signal` and `whatsapp` are stdio-only upstream; the Dockerfiles in `docker/`
front them with [supergateway](https://github.com/supercorp-ai/supergateway) so
TrueForge can reach them over HTTP.

| Skill | Source |
|---|---|
| `extract-social-media` | authored here → [kristopolous/hackieskills](https://github.com/kristopolous/hackieskills) |
| `find-discussions` | authored here → same repo |
| `apple-appstore-reviewer` | [github/awesome-copilot](https://github.com/github/awesome-copilot) |

Skills are pinned to a commit, not a branch, so one can't change underneath a
running agent. They execute in the agent's sandbox, which needs a sandbox
provider configured under Settings → Sandbox providers; until then the dashboard
runs `extract-social-media`'s scripts locally instead.

## How a scan works

Four agent turns, each held to a JSON schema (`app/server/schemas.ts`) so the
result is data rather than prose to scrape:

1. **Presence** — render the site with [Lightpanda](https://lightpanda.io) and
   classify its outbound links. Footers are built in JavaScript on most marketing
   sites, so a plain fetch finds nothing; this is the difference between four
   results and zero.
2. **Discovery** — search Reddit and Hacker News directly, Exa for everything
   else, and record what was said with its date and engagement.
3. **Buzz** — score each mention from −1 to +1 and write the verdict. The
   arithmetic that follows — bucketing, the volume-weighted mean, the delta —
   is computed in `pipeline.ts`, not asked of the model.
4. **Health** — triage the negative half into merged issues with a severity, the
   threads that back each one, and a reply to the people who raised it.

## Known limits

- **Docker containers on this machine have no outbound internet.** The `FORWARD`
  chain is `policy DROP` with Docker's own rules missing, so the Reddit and
  Hacker News connectors register fine but their searches fail. `sudo systemctl
  restart docker` reinstalls the rules. Until then, discovery falls back to Exa,
  which TrueForge reaches directly.
- **No tracker actually receives an issue yet.** Filing builds the real payload
  and marks the issue, and says plainly that it did not send. Add the Linear,
  Jira or GitHub connector to `src/registry.ts` to close the loop.
- **A small model will struggle.** Four turns with tool schemas in context is a
  lot to ask of an 8B model with a 15k window.
