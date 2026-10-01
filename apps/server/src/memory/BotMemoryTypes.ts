import * as NodeFSP from "node:fs/promises";
import { type AkeruMemoryDocumentTarget, type BotId, type GroupId } from "@akeru/contracts";
import * as Schema from "effect/Schema";

export const NodeFS = NodeFSP;

export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export const LOCK_STALE_AFTER_MS = 30_000;

export const LOCK_WAIT_LIMIT_MS = 5_000;

export const BotMemoryErrorReason = Schema.Union([
  Schema.TaggedStruct("access-denied", {}),
  Schema.TaggedStruct("ambiguous-match", {}),
  Schema.TaggedStruct("invalid-id", {}),
  Schema.TaggedStruct("invalid-operation", {}),
  Schema.TaggedStruct("io-error", {}),
  Schema.TaggedStruct("limit-exceeded", {}),
  Schema.TaggedStruct("lock-timeout", {}),
  Schema.TaggedStruct("lock-lost", {}),
  Schema.TaggedStruct("not-found", {}),
  Schema.TaggedStruct("unsafe-content", {}),
]);

export type BotMemoryErrorCode = typeof BotMemoryErrorReason.Type._tag;

export class BotMemoryError extends Schema.TaggedErrorClass<BotMemoryError>()("BotMemoryError", {
  reason: BotMemoryErrorReason,
  message: Schema.String,
  details: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
}) {
  static fromCode(code: BotMemoryErrorCode, message: string, details?: BotMemoryError["details"]) {
    return new BotMemoryError({
      reason: { _tag: code },
      message,
      ...(details === undefined ? {} : { details }),
    });
  }

  get code(): BotMemoryErrorCode {
    return this.reason._tag;
  }
}

export const makeBotMemoryError = BotMemoryError.fromCode;

export const toBotMemoryError = (cause: unknown): BotMemoryError =>
  isBotMemoryError(cause)
    ? cause
    : makeBotMemoryError("io-error", cause instanceof Error ? cause.message : String(cause), {
        cause,
      });

export interface BotMemoryAccess {
  readonly botId: BotId;
  readonly groupId: GroupId | null;
  readonly groupMemberBotIds: ReadonlyArray<BotId>;
}

export interface ResolvedDocument {
  readonly target: AkeruMemoryDocumentTarget;
  readonly filePath: string;
  readonly charLimit: number;
  readonly memoryRoot: string;
}

export interface ReadDocumentResult {
  readonly entries: ReadonlyArray<string>;
  readonly updatedAt: string | null;
}

export function assertSafeId(label: string, value: string): void {
  if (!SAFE_ID.test(value) || value === "." || value === "..") {
    throw makeBotMemoryError("invalid-id", `${label} is not a valid memory path identifier.`);
  }
}

const isBotMemoryError = Schema.is(BotMemoryError);
