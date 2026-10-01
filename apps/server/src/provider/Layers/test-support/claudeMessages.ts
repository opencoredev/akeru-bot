import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type * as Schema from "effect/Schema";

/** Partial wire snapshots exercise forward-compatible and malformed SDK messages. */
export function claudeMessage(fixture: {
  readonly [key: string]: Schema.Json | undefined;
}): SDKMessage {
  // SAFETY: This test boundary deliberately replays partial wire snapshots. The
  // adapter reads the fields under test defensively; absent SDK metadata is unused.
  return fixture as SDKMessage;
}
