import * as Schema from "effect/Schema";
import {
  BotId,
  GroupId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "../baseSchemas.ts";

export const AkeruMemoryDocumentTarget = Schema.Literals(["user", "memory", "group"]);

export type AkeruMemoryDocumentTarget = typeof AkeruMemoryDocumentTarget.Type;

export const AkeruMemoryFileOperation = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("add"),
    content: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    action: Schema.Literal("replace"),
    oldText: TrimmedNonEmptyString,
    content: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    action: Schema.Literal("remove"),
    oldText: TrimmedNonEmptyString,
  }),
]);

export type AkeruMemoryFileOperation = typeof AkeruMemoryFileOperation.Type;

export const AkeruMemoryDocument = Schema.Struct({
  target: AkeruMemoryDocumentTarget,
  content: Schema.String,
  charCount: NonNegativeInt,
  charLimit: PositiveInt,
  updatedAt: Schema.NullOr(IsoDateTime),
});

export type AkeruMemoryDocument = typeof AkeruMemoryDocument.Type;

export const AkeruBotMemorySnapshot = Schema.Struct({
  botId: BotId,
  groupId: Schema.NullOr(GroupId),
  user: AkeruMemoryDocument,
  memory: AkeruMemoryDocument,
  group: Schema.NullOr(AkeruMemoryDocument),
});

export type AkeruBotMemorySnapshot = typeof AkeruBotMemorySnapshot.Type;

export const AkeruMemoryFileMutationInput = Schema.Struct({
  botId: BotId,
  groupId: Schema.NullOr(GroupId),
  groupMemberBotIds: Schema.Array(BotId),
  target: AkeruMemoryDocumentTarget,
  operations: Schema.Array(AkeruMemoryFileOperation),
});

export type AkeruMemoryFileMutationInput = typeof AkeruMemoryFileMutationInput.Type;

export const AkeruMemoryFileMutationResult = Schema.Struct({
  document: AkeruMemoryDocument,
  applied: PositiveInt,
  changed: Schema.Boolean,
});

export type AkeruMemoryFileMutationResult = typeof AkeruMemoryFileMutationResult.Type;

export const AkeruMemoryDocumentsInspectInput = Schema.Struct({ threadId: ThreadId });

export type AkeruMemoryDocumentsInspectInput = typeof AkeruMemoryDocumentsInspectInput.Type;

export const AkeruMemoryDocumentsSnapshot = Schema.Struct({
  ...AkeruBotMemorySnapshot.fields,
  conversation: Schema.Struct({
    current: Schema.NullOr(
      Schema.Struct({
        generationCount: Schema.Number,
        activeObservations: Schema.String,
        createdAt: IsoDateTime,
        updatedAt: IsoDateTime,
      }),
    ),
    history: Schema.Array(
      Schema.Struct({
        generationCount: Schema.Number,
        activeObservations: Schema.String,
        createdAt: IsoDateTime,
        updatedAt: IsoDateTime,
      }),
    ),
  }),
});

export type AkeruMemoryDocumentsSnapshot = typeof AkeruMemoryDocumentsSnapshot.Type;

export const AkeruMemoryDocumentReplaceInput = Schema.Struct({
  threadId: ThreadId,
  expectedBotId: BotId,
  expectedContent: Schema.String,
  target: AkeruMemoryDocumentTarget,
  content: Schema.String,
});

export type AkeruMemoryDocumentReplaceInput = typeof AkeruMemoryDocumentReplaceInput.Type;

export const AkeruMemoryObservationsClearInput = Schema.Struct({ threadId: ThreadId });

export type AkeruMemoryObservationsClearInput = typeof AkeruMemoryObservationsClearInput.Type;
