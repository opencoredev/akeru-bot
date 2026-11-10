const queues = new Map<string, Promise<void>>();

/** Runs `action` after every earlier action queued under `key` in this process has settled. */
export function oneAtATime(key: string, action: () => Promise<void>): Promise<void> {
  const run = (queues.get(key) ?? Promise.resolve()).then(action);
  const settled = run.catch(() => undefined);
  queues.set(key, settled);

  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });

  return run;
}
