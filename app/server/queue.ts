/** One queue, one worker, and a record of what is waiting.
 *
 *  Runs used to start the moment somebody asked, which produced two problems at
 *  once. Asking twice for the same scan was refused outright — the second click
 *  got a "busy" notice and the intent was simply lost — while asking for two
 *  different companies started both, and they then fought over one search
 *  budget, one set of provider pacers and one inference endpoint, so each came
 *  back thinner than either would have alone.
 *
 *  A queue answers both: the second ask is remembered rather than refused, and
 *  the work is serialised so each run gets the whole budget. It also makes the
 *  thing visible, which is most of the point — a job that will start in four
 *  minutes is a different situation from one that silently did not start, and
 *  from the outside those looked identical.
 *
 *  In memory on purpose. A queue that survives a restart would restart work
 *  nobody is watching for, hours later, against a corpus that has moved on; the
 *  scans themselves are what persist, and a dropped job is re-askable in one
 *  click. What is written down is the outcome, on the scan.
 */

import { randomUUID } from 'node:crypto';
import type { Stage } from '../shared/types.ts';

export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  scanId: string;
  /** Named so the queue reads as work about companies rather than about ids. */
  company: string;
  /** Empty means a full scan. */
  stages: Stage[];
  options: { depth?: 'deep' | 'normal'; languages?: string[]; dig?: string };
  state: JobState;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** What went wrong, in its own words. */
  error?: string;
  /** Which stage it is on, while it runs. */
  stage?: Stage;
}

type Runner = (job: Job, onStage: (stage: Stage) => void) => Promise<void>;

const jobs: Job[] = [];
let runner: Runner | null = null;
let working = false;

/** How the queue actually performs a job. Injected so this module does not
 *  import the pipeline, which imports half the app. */
export const setRunner = (fn: Runner) => { runner = fn; };

export const listJobs = (limit = 50): Job[] => jobs.slice(0, limit);

export const queueDepth = (): number => jobs.filter((job) => job.state === 'queued').length;

/** Add work. Returns the job so the caller can report its position. */
export function enqueue(
  scanId: string,
  company: string,
  stages: Stage[],
  options: Job['options'] = {},
): Job {
  // Asking twice for the same thing is a double-click, not two jobs.
  const pending = jobs.find((job) =>
    job.state === 'queued'
    && job.scanId === scanId
    && job.stages.join() === stages.join());
  if (pending) return pending;

  const job: Job = {
    id: randomUUID().slice(0, 8),
    scanId,
    company,
    stages,
    options,
    state: 'queued',
    queuedAt: new Date().toISOString(),
  };
  jobs.unshift(job);
  if (jobs.length > 200) jobs.length = 200;
  void pump();
  return job;
}

export function cancelJob(id: string): boolean {
  const job = jobs.find((candidate) => candidate.id === id);
  // Only a job that has not begun. Stopping one in flight is the scan's own
  // cancel, which knows how to leave the record coherent.
  if (!job || job.state !== 'queued') return false;
  job.state = 'cancelled';
  job.finishedAt = new Date().toISOString();
  return true;
}

/** Run whatever is waiting, one at a time.
 *
 *  Serial, and that is the design rather than a limitation: the search budget,
 *  the per-provider pacers and the content cache are all per process, so two
 *  scans at once spend each other's allowance and both report a thin corpus. */
async function pump(): Promise<void> {
  if (working || !runner) return;
  working = true;
  try {
    for (;;) {
      const job = [...jobs].reverse().find((candidate) => candidate.state === 'queued');
      if (!job) return;

      job.state = 'running';
      job.startedAt = new Date().toISOString();
      try {
        await runner(job, (stage) => { job.stage = stage; });
        job.state = 'done';
      } catch (error) {
        job.state = 'failed';
        job.error = error instanceof Error ? error.message.slice(0, 300) : String(error);
      } finally {
        job.stage = undefined;
        job.finishedAt = new Date().toISOString();
      }
    }
  } finally {
    working = false;
  }
}
