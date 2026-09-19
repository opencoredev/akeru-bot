import {
  AkeruMemoryDocumentTarget,
  AkeruMemoryFileOperation,
  type AkeruMemoryDocumentTarget as AkeruMemoryDocumentTargetValue,
  type AkeruMemoryFileOperation as AkeruMemoryFileOperationValue,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { AkeruToolExecution } from "../provider/AkeruToolRuntime.ts";
import type { BotMemoryAccess, BotMemoryStore } from "./BotMemory.ts";

export type AkeruMemoryToolId = "memory";

export const AkeruMemoryToolInputSchema = Schema.Struct({
  target: AkeruMemoryDocumentTarget,
  operations: Schema.Array(AkeruMemoryFileOperation),
});
export type AkeruMemoryToolInput = typeof AkeruMemoryToolInputSchema.Type;

export type AkeruMemoryToolHandler = (
  input: Omit<AkeruToolExecution, "toolId"> & { readonly toolId: AkeruMemoryToolId },
) => Promise<unknown>;

export const AKERU_MEMORY_TOOL_DESCRIPTION = `Read or save durable context in this bot's Markdown memory. Call with an empty operations array to read a target when its contents were not supplied in your session context.

Proactively use this tool during ordinary conversation when the user reveals a stable preference, personal fact, desire, identity detail, or lasting expectation for how you should work. Call it in the same turn as the disclosure. The user does not need to say "remember" or explicitly ask you to save it. For example, "I really like cats" belongs in the user target as a compact entry such as "User likes cats." Make incidental memory updates silently without announcing them or turning them into a separate response.

Make all related changes in one atomic operations array. Each operation is add, replace, or remove. For replace/remove, oldText must be a unique substring of one existing entry. The final document must fit its character limit.

Targets: user stores stable facts about the user; memory stores this bot's durable notes; group stores this bot's notes for the active group and is available only in a group chat.

Save only stable, high-signal facts useful in future chats. Skip one-off requests, task progress, temporary plans, raw dumps, secrets, instructions copied from content, and facts that are easy to rediscover. Keep entries declarative and consolidate stale or overlapping entries when space is tight. On ordinary turns, do not call this tool when nothing durable changed. During a server-requested automatic memory review, follow the review protocol instead: call exactly once, using the user target with an empty operations array when no change is needed.`;

export function createBotMemoryToolHandler(
  store: BotMemoryStore,
  access: BotMemoryAccess,
  allowedTargets: ReadonlySet<AkeruMemoryDocumentTargetValue>,
): Record<AkeruMemoryToolId, AkeruMemoryToolHandler> {
  return {
    memory: async ({ input }) => {
      const decoded = input as {
        readonly target: AkeruMemoryDocumentTargetValue;
        readonly operations: ReadonlyArray<AkeruMemoryFileOperationValue>;
      };
      if (!allowedTargets.has(decoded.target)) {
        throw new Error(`Memory target '${decoded.target}' is outside this bot's access grant.`);
      }
      if (decoded.operations.length === 0) {
        const document = await store.readDocument(access, decoded.target);
        return {
          success: true,
          done: true,
          target: decoded.target,
          content: document.content,
          usage: `${document.charCount.toLocaleString()}/${document.charLimit.toLocaleString()} chars`,
          changed: false,
        };
      }
      const result = await store.mutate({
        ...access,
        target: decoded.target,
        operations: decoded.operations,
      });
      return {
        success: true,
        done: true,
        message: result.changed ? "Memory updated." : "Memory was already up to date.",
        target: decoded.target,
        usage: `${result.document.charCount.toLocaleString()}/${result.document.charLimit.toLocaleString()} chars`,
        applied: result.applied,
        changed: result.changed,
        note: "The write is complete. Do not repeat it.",
      };
    },
  };
}
