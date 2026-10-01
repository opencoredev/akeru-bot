import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  BotId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "../baseSchemas.ts";
import { AkeruAwaitHandleId } from "./inputs.ts";
import { AkeruToolApprovalClass } from "./catalog.ts";

export const AkeruToolReceiptPhase = Schema.Literals([
  "start",
  "progress",
  "approval",
  "success",
  "failure",
  "cancellation",
]);

export const AkeruToolFailureCode = Schema.Literals([
  "validation",
  "denied",
  "not_found",
  "timeout",
  "cancelled",
  "internal",
]);

export const AkeruToolReceipt = Schema.Struct({
  receiptId: TrimmedNonEmptyString,
  toolId: TrimmedNonEmptyString,
  phase: AkeruToolReceiptPhase,
  threadId: ThreadId,
  botId: Schema.optional(BotId),
  handleId: Schema.optional(AkeruAwaitHandleId),
  summary: Schema.optional(TrimmedNonEmptyString),
  authorizationUrl: Schema.optional(TrimmedNonEmptyString),
  progress: Schema.optional(NonNegativeInt),
  approvalClass: Schema.optional(AkeruToolApprovalClass),
  failureCode: Schema.optional(AkeruToolFailureCode),
  fatalToThread: Schema.Literal(false).pipe(
    Schema.withDecodingDefault(Effect.succeed(false as const)),
  ),
  billedBotId: Schema.optional(BotId),
  usage: Schema.optional(
    Schema.Struct({
      inputTokens: Schema.optional(NonNegativeInt),
      outputTokens: Schema.optional(NonNegativeInt),
      costUsd: Schema.optional(Schema.Number),
    }),
  ),
  createdAt: IsoDateTime,
});

export type AkeruToolReceipt = typeof AkeruToolReceipt.Type;
