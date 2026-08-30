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

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Stage } from '../../shared/types.ts';
import { askJsonDirect } from '../model.ts';
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
  /** Size of what went in and what came back, which is usually enough to spot
   *  a truncated response without opening it. */
  promptChars: number;
  resultChars?: number;
  /** How many things the call was asked to process, when it is a batch. */
  items?: number;
}

const RUNS_FILE = path.resolve(import.meta.dirname, '../../../data/agent-runs.jsonl');
const MAX_IN_MEMORY = 500;

const runs: AgentRun[] = [];
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

/** Which scan and stage the current work belongs to.
 *
 *  Carried in async context rather than threaded through every pipeline
 *  function as an extra parameter. The stage functions already take a company,
 *  a corpus and a log callback; adding a scan id to all of them — and to every
 *  caller — to satisfy bookkeeping would put the bookkeeping in the signature
 *  of the work. This keeps attribution automatic and correct across awaits.
 */
const context = new AsyncLocalStorage<{ scanId?: string; stage?: Stage }>();

export const withRunContext = <T>(value: { scanId?: string; stage?: Stage }, fn: () => T): T =>
  context.run(value, fn);

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
    scanId: options.scanId ?? context.getStore()?.scanId,
    stage: options.stage ?? context.getStore()?.stage ?? agent.stage,
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
    const result = await askJsonDirect<T>({
      instructions: agent.instructions,
      prompt: options.prompt,
      schema: agent.schema,
      timeoutMs: options.timeoutMs,
      role: agent.role ?? 'general',
    });
    run.status = 'ok';
    run.resultChars = JSON.stringify(result).length;
    return result;
  } catch (error) {
    run.status = 'failed';
    run.error = (error instanceof Error ? error.message : String(error)).slice(0, 400);
    throw error;
  } finally {
    run.endedAt = new Date().toISOString();
    run.ms = Date.now() - started;
    publish(run);
    persist(run);
  }
}
