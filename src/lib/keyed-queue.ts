/**
 * Runs tasks one at a time per key, in the order they were submitted.
 *
 * Storage drivers use it so that operations on one project's data (overlapping
 * saves from autosave and manual save, a delete, a copy) can never interleave.
 * A failing task does not block the ones queued behind it.
 */
export function createKeyedQueue(): <T>(key: string, task: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>();

  return function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve();
    const run = previous.then(task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
}
