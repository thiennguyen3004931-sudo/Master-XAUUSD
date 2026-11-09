export function runPhase7CSingleFlight<T>(
  inFlight: Map<string, Promise<unknown>>,
  key: string,
  factory: () => Promise<T>,
): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;

  let pending: Promise<T>;
  try {
    pending = factory();
  } catch (error) {
    return Promise.reject(error);
  }

  let tracked!: Promise<T>;
  tracked = pending.finally(() => {
    if (inFlight.get(key) === tracked) {
      inFlight.delete(key);
    }
  });

  inFlight.set(key, tracked as Promise<unknown>);
  return tracked;
}
