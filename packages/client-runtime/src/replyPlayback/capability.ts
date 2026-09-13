/** ChatGPT realtime is a live call, not stored-reply speech. LEO-401 owns synthesis. */
export const STORED_REPLY_SYNTHESIS_UNAVAILABLE =
  "Stored-reply speech is not connected yet. Akeru will not start a voice call or generate a new answer to read this reply.";

export type StoredReplySynthesisCapability =
  | {
      readonly available: false;
      readonly provider: string;
      readonly voice: string;
      readonly reason: string;
    }
  | {
      readonly available: true;
      readonly provider: string;
      readonly voice: string;
    };

export function storedReplySynthesisCapability(_voice?: {
  readonly enabled?: boolean;
  readonly provider?: string;
  readonly voice?: string;
}): StoredReplySynthesisCapability {
  return {
    available: false,
    provider: "unavailable",
    voice: "unavailable",
    reason: STORED_REPLY_SYNTHESIS_UNAVAILABLE,
  };
}
