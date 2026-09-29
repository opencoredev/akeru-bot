type ClearObservationalMemory = (threadId: string, resourceId?: string) => Promise<void>;

const owners = new Map<string, Set<ClearObservationalMemory>>();
const stores = new Set<ClearObservationalMemory>();

// Registers an observational-memory store that can clear any thread, so a
// durable invalidation still reaches threads no live harness has touched yet.
export function registerEntityMemoryStore(clear: ClearObservationalMemory): () => void {
  stores.add(clear);
  return () => {
    stores.delete(clear);
  };
}

export function registerEntityMemoryResource(
  threadId: string,
  resourceId: string,
  clear: ClearObservationalMemory,
): () => void {
  const key = `${threadId}\u0000${resourceId}`;
  const callbacks = owners.get(key) ?? new Set<ClearObservationalMemory>();
  callbacks.add(clear);
  owners.set(key, callbacks);
  return () => {
    callbacks.delete(clear);
    if (callbacks.size === 0) owners.delete(key);
  };
}

export async function invalidateEntityMemoryObservations(
  resources: ReadonlyArray<readonly [threadId: string, resourceId: string]>,
): Promise<void> {
  await Promise.all(
    resources.flatMap(([threadId, resourceId]) =>
      [...new Set([...stores, ...(owners.get(`${threadId}\u0000${resourceId}`) ?? [])])].map(
        (clear) => clear(threadId, resourceId),
      ),
    ),
  );
}
