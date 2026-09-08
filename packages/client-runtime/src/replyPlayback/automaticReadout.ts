export const AUTOMATIC_READOUT_STORAGE_KEY = "akeru.replyPlayback.automaticReadout";

export function decodeAutomaticReadoutPreference(value: string | null | undefined) {
  return value === "true";
}

export interface CompletedReply {
  readonly messageId: string;
  readonly contentVersion: string;
  readonly text: string;
  readonly successful: boolean;
}

/** Feed ordered live completions, never timeline snapshots or message-update events. */
export function createAutomaticReadoutTracker() {
  let scope: string | null = null;
  let cursor = -1;
  let enabled = false;
  const completed = new Set<string>();
  return {
    setEnabled: (next: boolean) => {
      enabled = next;
    },
    reset: (nextScope: string | null, snapshotCursor: number) => {
      scope = nextScope;
      cursor = snapshotCursor;
      completed.clear();
    },
    hydrate: (snapshotCursor: number) => {
      cursor = Math.max(cursor, snapshotCursor);
    },
    completed: (eventScope: string, sequence: number, reply: CompletedReply) => {
      if (eventScope !== scope || !Number.isSafeInteger(sequence) || sequence <= cursor)
        return null;
      cursor = sequence;
      if (completed.has(reply.messageId)) return null;
      // Stop automatic reading rather than evict identities and risk replaying old replies.
      if (completed.size >= 2048) return null;
      completed.add(reply.messageId);
      return enabled && reply.successful && reply.text.trim() ? reply : null;
    },
  };
}
