type ClearObservationalMemory = (threadId: string, resourceId?: string) => Promise<void>;

const owners = new Map<string, Set<ClearObservationalMemory>>();

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
      [...(owners.get(`${threadId}\u0000${resourceId}`) ?? [])].map((clear) =>
        clear(threadId, resourceId),
      ),
    ),
  );
}
