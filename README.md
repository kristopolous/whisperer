# Whisperer

Watches the open internet for complaints about a product, confirms which ones
are real, files them, tries to fix them, and closes the loop with the person who
complained.

Give it a company name, a website or a repository URL. It works out what the
subject actually is, finds where people talk about it, reads what they said,
separates grumbling from defects, gives each defect a reproduction test, and —
where the source is reachable — reads that source, writes a patch and runs the
test suite against it.

**The defect list is the product.** Sentiment scores, the live feed, review
scorecards and topic charts are context around it. A scan that produces a
beautiful chart and no issues has failed.

Every run is kept, and the point of keeping them is comparison: reputation is a
series of observations, not a pile of text.

## What is actually built

| | |
|---|---|
| **Retrieval** | Six search providers with per-role chains, per-provider pacers and a spend ledger; direct readers for Reddit (PRAW), Hacker News (Algolia), GitHub issues and the App Store; a scraper path for pages that refuse a plain fetch |
| **Judgement** | Subject disambiguation, complaint triage, sentiment scoring, defect merging, feed quality, abuse sweep — each held to a JSON schema, each quoting its evidence before its verdict |
| **Accounting** | Per-source coverage grid, a suppression ledger that names every dropped result and why, and a credit ledger per provider |
| **The loop** | Diagnose against real source, patch, run the suite in a throwaway copy, open a PR, file a ticket, draft the reply — with an audit trail per defect |
| **Operation** | A serial job queue with a visible panel, resumable stages, per-batch checkpoints, and a circuit breaker that stops a stage rather than grinding against a dead model host |

## What is not

- **Nothing is sent to a real person.** Every reply the system would post goes to
  an outbox instead (`app/server/outbox.ts`). These are strangers who did not ask
  to be contacted, and a bug in the draft logic would publish under the company's
  name in a public thread.
- **Filing is wired for GitHub only.** Linear and Jira build the exact payload
  and say plainly that they did not send it.
- **One JSON file holds every scan** (`data/scans.json`), rewritten on each
  checkpoint. Fine for a laptop; the first thing to replace at any real volume.

## Getting it running

**1. Inference.** Whisperer talks to any OpenAI-compatible endpoint — set it in
the dashboard under **settings → inference**, or in `data/settings.json`. Hosts
are per *role* (`general`, `coding`), so the model that reads a thousand Reddit
comments need not be the one that writes a patch.

Set the **context length** for each host. It defaults to 15,000 tokens, and that
number is load-bearing: batch sizes are derived from it (`reading-budget.ts`), so
a host with a smaller real window returns truncated JSON with its own error
spliced into the middle, and a host with a larger one is driven at a fraction of
what it could hold.

**2. Credentials.** `cp .env.example .env`, or use **settings → connectors** in
the dashboard. Everything is optional and a missing credential simply removes
that path. Nothing is shown back once saved (`data/settings.json`, mode 0600) and
no credential is ever put in a prompt.

**3. Reddit, if you want it.** Discovery talks to Reddit's official API with
PRAW, which needs a virtualenv:

```bash
python3 -m venv .venv && .venv/bin/pip install praw
```

A virtualenv rather than `pip install praw`, because a Debian host refuses
installs into its system interpreter (PEP 668) and `--user` is no better —
`~/.local` is invisible to a process started without `HOME`. The server looks for
`.venv/bin/python3` beside the checkout; set `WHISPERER_PYTHON` for an
interpreter elsewhere.

**4. Run it.**

```bash
npm run build && npm start     # API + dashboard on :8791
npm run dev                    # or: API on :8791, Vite on :5173, both watching
```

`:8791` serves the **built** bundle, so `npm run dev` alone does not update it —
edit with Vite on `:5173`, or rebuild. The server says so on startup and puts a
banner on the page when `dist` is older than `src`, because "my change did
nothing" is otherwise indistinguishable from a bug.

## Scripts

| Command | What it does |
|---|---|
| `npm start` | API and dashboard, no watcher — what a long scan wants |
| `npm run dev` | Both halves with watchers. A file save restarts the API and kills any scan in flight |
| `npm run build` | Build the dashboard into `app/web/dist` |
| `npm test` | Node's test runner over `app/server` and `app/shared` |
| `npm run typecheck` | `tsc` over everything |
| `npm run setup` | Apply `src/registry.ts` to a TrueForge instance, if you use one |

## How a scan works

Seven stages, each independently re-runnable, each checkpointing as it goes so a
restart resumes rather than restarts.

1. **Subject** — decide what was typed. A repository URL is read from the host's
   API; anything else is resolved from search evidence. Settles the search term,
   the aliases, the things it must *not* be confused with, the site, and the
   repository.
2. **Sources** — where this subject is discussed, and — more usefully — where it
   is not. Editable, because a wrong entry sends every later stage somewhere
   useless.
3. **Discovery** — the corpus. Paginated general search plus a complaint
   vocabulary, in several languages, alongside direct reads of Reddit, Hacker
   News, the project's own tracker and the App Store. Every result that is
   dropped is counted against a reason.
4. **Feed** — the newest material, read to tell a datapoint from a sign-in wall.
5. **Buzz** — a score per mention, from the fetched page rather than a search
   snippet. The arithmetic that follows is computed, not asked of a model.
6. **Health** — merge complaints into defects, each with a severity, its
   evidence, a reproduction test, and a draft reply.
7. **Integrity** — impersonation, phishing, fake support, and the review-site
   scorecard. Last, because it is slowest and every earlier stage stands without
   it.

### Two rules the pipeline is built around

**Evidence before verdict.** Every classification quotes the text it relies on
*before* it answers, and the caller checks the quote actually occurs in the
source. A quote that cannot be found is a fabricated one, and the verdict resting
on it is discarded.

**Nothing is dropped silently.** Every filter records what it removed, from which
source, and why — with a sample of the URLs. The coverage grid shows it per
source per month, so an empty band can be read as "nobody posted", "nobody
looked", "the provider returned nothing" or "our own filter ate it". They demand
opposite responses and used to look identical.

## The coverage grid

One row per source, one column per month, one cell per source-per-month.

- **Click a source name** to see what it returned and what was dropped, by
  reason, with examples.
- **Click a cell** to search that source for that window specifically. The dates
  go into the query *as text* — `"Aug 1, 2026"`, four formats per day — because
  most providers have no parameter for an arbitrary range and silently answer
  with everything when asked for one. A page written on a date usually prints it.
- A cell being searched shows marching ants until the work lands.
- A cell that has been searched and came back empty is **hatched**, because "we
  looked and it is quiet" is a finding and "nobody looked" is a gap.

## Defects

Each defect carries a **reproduction test** — the concrete steps and the
observation that decides it. It is required, and where the reports genuinely do
not support one the model must say so rather than invent conditions.

That test gates the expensive work: reading a repository and running its suite
against "it runs like ass" cannot conclude anything, so the loop refuses to start
until there is something that could turn out to be false.

The **resolution ladder** on each defect is the interface: reported → reproduced
→ filed → reached out → fixed → confirmed → closed. Exactly one rung is next,
and that rung carries the only button, because what this screen owes the reader
is the next move rather than a menu.

## Layout

```
app/
  shared/          types, HTML and markdown handling shared by both halves
  server/
    pipeline.ts      the stages themselves
    stages.ts        stage dispatch, checkpointing, the retrieval audit
    queue.ts         one worker, serial by design — see below
    search.ts        the provider chain, pacers, pagination, widening
    providers.ts     which connector serves which role, and in what order
    reading-budget.ts batch sizes derived from the host's context window
    suppression.ts   what was dropped, from where, and why
    date-queries.ts  searching a window by writing its dates into the query
    own-site.ts      whose page is whose — path-aware on shared hosts
    rescue.ts        ask the model when a parser fails, then verify its answer
    upstream-trouble.ts  stop a stage rather than grind against a dead host
    agents/          every agent as a first-class definition, with run history
    sources/         direct readers: Hacker News, GitHub issues, the App Store
    channels/        GitHub: forking, and filing to a fork
  web/               the dashboard
skills/reddit-search  the PRAW reader
data/                scans, settings, credits — none of it in git
```

**The queue is serial on purpose.** One search budget, one set of provider
pacers, one content cache, one inference endpoint — all per process. Two scans at
once spend each other's allowance and both come back thin, with nothing in either
report saying why. A second ask is queued, never refused, and the queue panel
shows what is running and what is waiting.

## Known problems

- **`data/scans.json` is rewritten whole on every checkpoint.** Hundreds of
  rewrites per scan. Per-scan files are the fix.
- **A file save during `npm run dev` kills the running scan.** `tsx --watch`
  restarts the API. Use `npm start` for anything long.
- **The queue is in memory.** A restart loses what was waiting; the scans
  themselves survive.
- **Model stages run their batches in sequence.** `pool.ts` exists and is not
  yet wired in.
- **Providers differ on date ranges.** Brave takes an explicit range and Google
  takes `after:`/`before:`; the rest take day/week/month/year and quietly ignore
  anything else. The dated-query text is what makes a window work everywhere.
