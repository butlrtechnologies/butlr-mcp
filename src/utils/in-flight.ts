/**
 * Share one in-flight promise per key: a second caller with the same key
 * while the first is still running gets the same promise instead of
 * starting the work again. The entry is removed once it settles, so this
 * never caches a result (pair it with a real cache for that).
 */
const inFlight = new Map<string, Promise<unknown>>();

export function shareInFlight<T>(key: string, work: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const promise = work().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}
