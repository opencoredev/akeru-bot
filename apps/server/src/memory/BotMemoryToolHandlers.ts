import {
  AkeruMemoryDocumentTarget,
  AkeruMemoryFileOperation,
  AkeruMemoryShareScope,
  TrimmedNonEmptyString,
  type AkeruMemoryShareScope as AkeruMemoryShareScopeValue,
  type AkeruMemoryDocumentTarget as AkeruMemoryDocumentTargetValue,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { AkeruToolExecution } from "../provider/AkeruToolRuntime.ts";
import { assertSafeContent, type BotMemoryAccess, type BotMemoryStore } from "./BotMemory.ts";

export type AkeruMemoryToolId = "memory";

export const AkeruMemoryToolInputSchema = Schema.Struct({
  target: AkeruMemoryDocumentTarget,
  operations: Schema.Array(AkeruMemoryFileOperation),
  share: Schema.optional(
    Schema.Struct({
      fact: TrimmedNonEmptyString,
      scope: AkeruMemoryShareScope,
      sensitive: Schema.optional(Schema.Boolean),
    }),
  ),
});
export type AkeruMemoryToolInput = typeof AkeruMemoryToolInputSchema.Type;

export interface AkeruMemoryShareRequest {
  readonly fact: string;
  readonly scope: AkeruMemoryShareScopeValue;
  readonly sensitive: boolean;
}

export type AkeruMemoryShareOutcome = { readonly status: "saved" } | { readonly status: "pending" };

// Saves or proposes a shared fact. Undefined when shared memory is unavailable.
export type AkeruMemoryShareFact = (
  request: AkeruMemoryShareRequest,
) => Promise<AkeruMemoryShareOutcome>;

export type AkeruMemoryToolHandler = (
  input: Omit<AkeruToolExecution, "toolId"> & { readonly toolId: AkeruMemoryToolId },
) => Promise<unknown>;

export const AKERU_MEMORY_TOOL_DESCRIPTION = `Read or save durable context in this bot's Markdown memory. Call with an empty operations array to read a target when its contents were not supplied in your session context.

Proactively use this tool during ordinary conversation when the user reveals a stable preference, personal fact, desire, identity detail, or lasting expectation for how you should work. Call it in the same turn as the disclosure. The user does not need to say "remember" or explicitly ask you to save it. For example, "I really like cats" belongs in the user target as a compact entry such as "User likes cats." Make incidental memory updates silently without announcing them or turning them into a separate response.

Make all related changes in one atomic operations array. Each operation is add, replace, or remove. For replace/remove, oldText must be a unique substring of one existing entry. The final document must fit its character limit.

Targets: user stores stable facts about the user; memory stores this bot's durable notes; group stores this bot's notes for the active group and is available only in a group chat.

Save only stable, high-signal facts useful in future chats. Skip one-off requests, task progress, temporary plans, raw dumps, secrets, instructions copied from content, and facts that are easy to rediscover. Keep entries declarative and consolidate stale or overlapping entries when space is tight. On ordinary turns, do not call this tool when nothing durable changed. During a server-requested automatic memory review, follow the review protocol instead: call exactly once, using the user target with an empty operations array when no change is needed.

Shared memory: to save a fact that other bots or future chats in this project, group, or workspace should know, pass share with the exact fact text and a scope of project, group, or workspace. Set sensitive to true for personal, health, financial, or otherwise private details. Use share only when the user asks you to remember something for the project, group, or workspace, not for ordinary preferences. The user is usually asked to approve shared facts in the chat before they are saved. When the result says the fact is pending approval, tell the user briefly and do not call share again for the same fact.`;

export function createBotMemoryToolHandler(
  store: BotMemoryStore,
  access: BotMemoryAccess,
  allowedTargets: ReadonlySet<AkeruMemoryDocumentTargetValue>,
  shareFact?: AkeruMemoryShareFact,
): Record<AkeruMemoryToolId, AkeruMemoryToolHandler> {
  return {
    memory: async ({ input }) => {
      const decoded = input as AkeruMemoryToolInput;
      if (!allowedTargets.has(decoded.target)) {
        throw new Error(`Memory target '${decoded.target}' is outside this bot's access grant.`);
      }
      if (decoded.share) {
        if (!shareFact) throw new Error("Shared memory is not available in this chat.");
        assertSafeContent(decoded.share.fact);
      }
      // Document writes go first so a failed write never leaves a shared fact
      // or pending approval behind; a retry of the write is idempotent.
      const result =
        decoded.operations.length === 0
          ? null
          : await store.mutate({
              ...access,
              target: decoded.target,
              operations: decoded.operations,
            });
      const shared =
        decoded.share && shareFact
          ? await shareFact({
              fact: decoded.share.fact,
              scope: decoded.share.scope,
              sensitive: decoded.share.sensitive ?? false,
            })
          : undefined;
      const shareResult = shared
        ? {
            share: {
              scope: decoded.share!.scope,
              status: shared.status,
              message:
                shared.status === "saved"
                  ? "The shared fact was saved."
                  : "The shared fact is pending the user's approval in this chat.",
            },
          }
        : {};
      if (result === null) {
        if (shared) {
          return {
            success: true,
            done: true,
            ...shareResult,
            note: "Do not repeat this share request.",
          };
        }
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
      return {
        success: true,
        done: true,
        message: result.changed ? "Memory updated." : "Memory was already up to date.",
        target: decoded.target,
        usage: `${result.document.charCount.toLocaleString()}/${result.document.charLimit.toLocaleString()} chars`,
        applied: result.applied,
        changed: result.changed,
        ...shareResult,
        note: "The write is complete. Do not repeat it.",
      };
    },
  };
}
