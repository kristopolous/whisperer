/** Run an agent, and keep a record of what happened.
 *
 *  The record is the point. The reason for owning the agent layer at all rather
 *  than renting it is that a run has to be answerable afterwards: which agent,
 *  fired by what, how long it took, how much it was given, what came back, and
 *  if it failed then why — in the failure's own words, not a generic one.
 *
 *  A platform that cannot tell you whether a run succeeded turns every empty
 *  panel into an investigation. This module is the alternative: every model
 *  call in the app goes through `runAgent`, and every one of them lands in a
 *  list the dashboard can render live.
 *
 *  Deliberately not an agent framework. There is no tool loop here, because the
 *  agents that run in the pipeline reason over a corpus that deterministic code
 *  has already fetched. If a tool-using agent is added later, its calls belong
 *  in the same record, as steps on the run.
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Stage } from '../../shared/types.ts';
import { askJsonDirect } from '../model.ts';
import { currentRun } from '../run-context.ts';
import { describeError, why } from '../errors.ts';
import type { AgentDefinition } from './types.ts';

export type RunStatus = 'running' | 'ok' | 'failed';

export interface AgentRun {
  id: string;
  /** Agent name, e.g. whisperer-buzz. */
  agent: string;
  title: string;
  /** The scan this was fired for, when it was part of one. */
  scanId?: string;
  stage?: Stage;
  /** What this particular call was for, when an agent runs more than once in a
   *  stage — "batch 2/5" is the difference between a useful list and a wall of
   *  identical rows. */
  note?: string;
  startedAt: string;
  endedAt?: string;
  ms?: number;
  status: RunStatus;
  /** The failure in its own words. Truncated, never rewritten. */
  error?: string;
  /** What the model actually said, when it could not be parsed.
   *
   *  Kept only on failures, and only for parse errors. Twice now a batch has
   *  died on malformed JSON and the record held the message but not the text,
   *  which left the cause to be guessed at from a character offset into a
   *  document nobody had. */
  raw?: string;
  /** Size of what went in and what came back, which is usually enough to spot
   *  a truncated response without opening it. */
  promptChars: number;
  resultChars?: number;
  /** How many things the call was asked to process, when it is a batch. */
  items?: number;
}

const RUNS_FILE = path.resolve(import.meta.dirname, '../../../data/agent-runs.jsonl');
const MAX_IN_MEMORY = 500;

const runs: AgentRun[] = loadHistory();

/** Read back what previous processes recorded.
 *
 *  Without this the panel does not show what an agent has ever done, it shows
 *  what it has done since the last restart — and with a file watcher on the
 *  server that is usually nothing. Two agents that had run sixteen and fifteen
 *  times, including every step of the one investigation that went end to end,
 *  were both reported as "never run".
 *
 *  Only the tail: this is a display cache, not an archive. The whole history
 *  stays in the file for anything that wants to read it properly. */
function loadHistory(): AgentRun[] {
  try {
    const lines = readFileSync(RUNS_FILE, 'utf8').split('\n').filter(Boolean);
    return lines
      .slice(-MAX_IN_MEMORY)
      .map((line) => {
        // A line at a time, because the last one can be half-written: the file
        // is appended to by a process that can be killed mid-write, and one
        // torn record must not cost the other four hundred.
        try {
          return JSON.parse(line) as AgentRun;
        } catch {
          return null;
        }
      })
      .filter((run): run is AgentRun => Boolean(run?.id && run?.agent))
      // Newest first, matching the order `unshift` maintains from here on.
      .reverse()
      .map((run) => (run.status === 'running'
        // Nothing survives a restart, so a record still claiming to be in
        // flight is a process that died holding it. Same reasoning as the
        // interrupted scans in the store.
        ? { ...run, status: 'failed' as const, error: run.error ?? 'Interrupted — the server stopped mid-run.' }
        : run));
  } catch {
    return [];
  }
}
const listeners = new Set<(run: AgentRun) => void>();

/** Subscribe to run changes — one call per state transition, so a live view can
 *  show a run appear and then settle. Returns the unsubscribe. */
export function onAgentRun(listener: (run: AgentRun) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(run: AgentRun) {
  for (const listener of listeners) {
    try {
      listener(run);
    } catch {
      // A broken listener (a disconnected SSE client, usually) must not take
      // down the run that was being reported.
    }
  }
}

/** Finished runs are appended to a log so the history outlives the process.
 *  JSONL rather than a rewritten array: a scan produces a run every few seconds
 *  and a half-written array file is worse than no file. */
function persist(run: AgentRun) {
  try {
    mkdirSync(path.dirname(RUNS_FILE), { recursive: true });
    appendFileSync(RUNS_FILE, JSON.stringify(run) + '\n');
  } catch {
    // History is a convenience; losing it must not fail a scan.
  }
}

export const recentRuns = (limit = 100): AgentRun[] => runs.slice(0, limit);

export const runsForScan = (scanId: string): AgentRun[] =>
  runs.filter((run) => run.scanId === scanId);

/** Per-agent rollup for the agent list: has it ever run, how did it go, how
 *  long does it usually take. */
export interface AgentStats {
  runs: number;
  failures: number;
  lastStatus?: RunStatus;
  lastAt?: string;
  lastError?: string;
  medianMs?: number;
}

export function statsFor(agentName: string): AgentStats {
  const mine = runs.filter((run) => run.agent === agentName);
  const settled = mine.filter((run) => run.status !== 'running');
  const durations = settled.map((run) => run.ms ?? 0).filter(Boolean).sort((a, b) => a - b);
  const last = mine[0];
  return {
    runs: mine.length,
    failures: mine.filter((run) => run.status === 'failed').length,
    lastStatus: last?.status,
    lastAt: last?.startedAt,
    lastError: mine.find((run) => run.status === 'failed')?.error,
    medianMs: durations.length ? durations[Math.floor(durations.length / 2)] : undefined,
  };
}

/* The run context — which scan and stage this is, and its cancellation
 * signal — lives in ../run-context.ts so the model and search clients can read
 * it without importing this module, which imports them. Re-exported here
 * because `withRunContext` reads as part of the agent runtime's surface. */
export { withRunContext, type RunContext } from '../run-context.ts';

/** Failures that are the endpoint hiccupping rather than the request being
 *  wrong. An empty body and a reply that stops mid-JSON are both the same
 *  thing from the caller's side: nothing usable came back, and the identical
 *  request often works a second later. A bad prompt or a rejected key fails
 *  the same way every time and must not be retried. */
const FLAKY = new RegExp([
  'empty response',
  'no JSON in model output',
  // Every JSON syntax error belongs here. They are all the same event from the
  // caller's side — the model produced something unusable — and the identical
  // request usually works a second later. parseJson repairs the one that is
  // mechanically fixable (raw control characters); this covers the rest, like
  // a reply that simply stops mid-token.
  'Unexpected end of JSON',
  'Unexpected token',
  'Unterminated string',
  'Bad control character',
  "Expected ',' or",
  'is not valid JSON',
  // A transport failure reaching the model endpoint. Local hosts drop a
  // connection now and then — often while a model is being swapped in — and the
  // next request goes through. Losing a stage to that is the same waste as
  // losing one to an empty reply.
  'fetch failed',
  'ECONNRESET',
  'socket hang up',
].join('|'), 'i');

/** One retry on a flaky failure.
 *
 *  One, not three. These calls are a minute of local model time each, so a
 *  retry storm turns a slow stage into a stalled one — and a second empty
 *  reply is evidence the batch is genuinely too big rather than unlucky. */
async function withRetry<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!FLAKY.test(message)) throw error;
    return call();
  }
}

export interface RunOptions {
  prompt: string;
  scanId?: string;
  stage?: Stage;
  note?: string;
  items?: number;
  timeoutMs?: number;
}

/** Ask an agent for its JSON, recording the run either way.
 *
 *  The error is re-thrown after being recorded: callers already decide what a
 *  failed batch means (skip it, fail the stage), and swallowing it here would
 *  take that decision away. The record exists so that decision is visible.
 */
export async function runAgent<T>(agent: AgentDefinition, options: RunOptions): Promise<T> {
  const run: AgentRun = {
    id: randomUUID().slice(0, 8),
    agent: agent.name,
    title: agent.title,
    scanId: options.scanId ?? currentRun()?.scanId,
    stage: options.stage ?? currentRun()?.stage ?? agent.stage,
    note: options.note,
    startedAt: new Date().toISOString(),
    status: 'running',
    promptChars: options.prompt.length,
    items: options.items,
  };

  runs.unshift(run);
  if (runs.length > MAX_IN_MEMORY) runs.length = MAX_IN_MEMORY;
  publish(run);

  const started = Date.now();
  try {
    const result = await withRetry(() => askJsonDirect<T>({
      instructions: agent.instructions,
      prompt: options.prompt,
      schema: agent.schema,
      timeoutMs: options.timeoutMs,
      role: agent.role ?? 'general',
    }));
    run.status = 'ok';
    run.resultChars = JSON.stringify(result).length;
    return result;
  } catch (error) {
    run.status = 'failed';
    run.error = why(error);
    const raw = (error as { raw?: string }).raw;
    if (raw) run.raw = raw.slice(0, 4_000);
    throw error;
  } finally {
    run.endedAt = new Date().toISOString();
    run.ms = Date.now() - started;
    publish(run);
    persist(run);
  }
}
