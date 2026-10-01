import { BotId } from "@akeru/contracts";
import * as Schema from "effect/Schema";
import { MemoryApprovalError } from "./MemoryShareProposal.ts";

export const AffectedBotIdsJson = Schema.fromJsonString(Schema.Array(BotId));

export const encodeAffectedBotIds = Schema.encodeEffect(AffectedBotIdsJson);

export const CandidateRow = Schema.Struct({
  candidateId: Schema.String,
  tenantId: Schema.String,
  sourceThreadId: Schema.String,
  sourceMessageId: Schema.NullOr(Schema.String),
  authorBotId: Schema.NullOr(Schema.String),
  fact: Schema.String,
  scope: Schema.String,
  sensitive: Schema.Number,
  confidence: Schema.Number,
  affectedBotIds: AffectedBotIdsJson,
  status: Schema.String,
});

export const ReceiptRow = Schema.Struct({
  status: Schema.String,
  fact: Schema.String,
  scope: Schema.String,
  affectedBotIds: AffectedBotIdsJson,
  memoryRootId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});

export const decodeCandidateRow = Schema.decodeUnknownEffect(CandidateRow);

export const decodeReceiptRow = Schema.decodeUnknownEffect(ReceiptRow);

export const failWith = (message: string) => (cause: unknown) =>
  new MemoryApprovalError({
    message:
      typeof cause === "object" && cause !== null && "message" in cause
        ? `${message}: ${String(cause.message)}`
        : message,
  });
