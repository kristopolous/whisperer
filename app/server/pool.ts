/** Run work in parallel, with a ceiling.
 *
 *  Every model stage in this pipeline batched its work and then awaited each
 *  batch in turn — a shape that makes sense for one slow endpoint and for
 *  nothing else. On an inference tier that can be fanned out across many
 *  endpoints, a feed pass of fifty-eight batches spent fifty-seven of them
 *  waiting, and the wall clock was the batch count times the latency rather
 *  than anything to do with how much there was to read.
 *
 *  Bounded rather than unbounded: the ceiling is what stops a two-thousand-item
 *  corpus opening two thousand sockets at once, and it is the one number to
 *  turn when the routing behind the endpoint changes.
 *
 *  Order is preserved in the results regardless of what finishes first, because
 *  several callers map results back onto their input by position and a
 *  completion-ordered array would silently attach one batch's verdicts to
 *  another batch's items.
 */

export const MODEL_CONCURRENCY = Number(process.env.MODEL_CONCURRENCY ?? 12);

export async function pooled<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  limit = MODEL_CONCURRENCY,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  });

  await Promise.all(runners);
  return results;
}
