/**
 * Map over items with at most `limit` calls in flight, preserving order.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * A scheduler that runs at most `limit` tasks at once. Unlike
 * mapWithConcurrency, each task gets its own promise, so a caller can start
 * a batch and await the results one by one as it needs them.
 */
export function createLimiter(limit: number): <R>(task: () => Promise<R>) => Promise<R> {
  let active = 0;
  const queue: Array<() => void> = [];
  const release = () => {
    active--;
    queue.shift()?.();
  };
  return <R>(task: () => Promise<R>) =>
    new Promise<R>((resolve, reject) => {
      const start = () => {
        active++;
        task().then(resolve, reject).finally(release);
      };
      if (active < limit) start();
      else queue.push(start);
    });
}
