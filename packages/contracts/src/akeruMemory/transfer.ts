import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import {
  BotId,
  GroupId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "../baseSchemas.ts";
import { AkeruMemoryRootId, AkeruMemoryRevision, AkeruMemoryCandidate } from "./base.ts";
import { AkeruMemoryDocumentTarget } from "./documents.ts";

// Scopes a bot may propose through the memory tool. Private and bot-only
// facts belong in the bot's own memory documents.
export const AkeruMemoryShareScope = Schema.Literals(["project", "group", "workspace"]);

export type AkeruMemoryShareScope = typeof AkeruMemoryShareScope.Type;

export const AkeruMemoryArchiveFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  mediaType: Schema.Literal("text/markdown"),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  content: Schema.String,
});

export type AkeruMemoryArchiveFile = typeof AkeruMemoryArchiveFile.Type;

export const AkeruMemoryArchiveV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  threadId: ThreadId,
  complete: Schema.Boolean,
  createdAt: IsoDateTime,
  files: Schema.Array(AkeruMemoryArchiveFile),
  manifestSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});

export type AkeruMemoryArchiveV1 = typeof AkeruMemoryArchiveV1.Type;

export const AkeruMemoryArchiveTarget = Schema.Literals([
  "thread",
  "bot",
  "project",
  "workspace",
  "all",
]);

export type AkeruMemoryArchiveTarget = typeof AkeruMemoryArchiveTarget.Type;

export const AkeruMemoryArchiveRevision = Schema.Struct({
  revision: AkeruMemoryRevision,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});

export type AkeruMemoryArchiveRevision = typeof AkeruMemoryArchiveRevision.Type;

export const AkeruMemoryInspectInput = Schema.Struct({ threadId: ThreadId });

export type AkeruMemoryInspectInput = typeof AkeruMemoryInspectInput.Type;

export const AkeruConversationMemoryRecord = Schema.Struct({
  id: TrimmedNonEmptyString,
  generationCount: NonNegativeInt,
  originType: Schema.Literals(["initial", "reflection"]),
  activeObservations: Schema.String,
  bufferedObservations: Schema.String,
  bufferedReflection: Schema.NullOr(Schema.String),
  totalTokensObserved: NonNegativeInt,
  observationTokenCount: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export type AkeruConversationMemoryRecord = typeof AkeruConversationMemoryRecord.Type;

export const AkeruConversationMemorySnapshot = Schema.Struct({
  current: Schema.NullOr(AkeruConversationMemoryRecord),
  history: Schema.Array(AkeruConversationMemoryRecord),
});

export type AkeruConversationMemorySnapshot = typeof AkeruConversationMemorySnapshot.Type;

export const AkeruMarkdownMemoryArchiveDocument = Schema.Struct({
  botId: BotId,
  groupId: Schema.NullOr(GroupId),
  target: AkeruMemoryDocumentTarget,
  path: TrimmedNonEmptyString,
  content: Schema.String,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});

export type AkeruMarkdownMemoryArchiveDocument = typeof AkeruMarkdownMemoryArchiveDocument.Type;

export const AkeruMarkdownMemoryArchiveV3 = Schema.Struct({
  schemaVersion: Schema.Literal(3),
  anchorThreadId: ThreadId,
  botId: BotId,
  groupId: Schema.NullOr(GroupId),
  createdAt: IsoDateTime,
  documents: Schema.Array(AkeruMarkdownMemoryArchiveDocument),
  conversation: Schema.Struct({
    snapshot: AkeruConversationMemorySnapshot,
    sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  }),
  manifestSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});

export type AkeruMarkdownMemoryArchiveV3 = typeof AkeruMarkdownMemoryArchiveV3.Type;

export const AkeruMarkdownMemoryExportInput = Schema.Struct({
  threadId: ThreadId,
  target: AkeruMemoryArchiveTarget.pipe(
    Schema.withDecodingDefault(Effect.succeed("thread" as const)),
  ),
  complete: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});

export type AkeruMarkdownMemoryExportInput = typeof AkeruMarkdownMemoryExportInput.Type;

export const AkeruMarkdownMemoryImportPreviewInput = Schema.Struct({
  threadId: ThreadId,
  archive: AkeruMarkdownMemoryArchiveV3,
});

export type AkeruMarkdownMemoryImportPreviewInput =
  typeof AkeruMarkdownMemoryImportPreviewInput.Type;

export const AkeruMarkdownMemoryImportPreviewItem = Schema.Struct({
  target: AkeruMemoryDocumentTarget,
  classification: Schema.Literals(["new", "changed", "unchanged"]),
  charCount: NonNegativeInt,
  charLimit: PositiveInt,
});

export type AkeruMarkdownMemoryImportPreviewItem = typeof AkeruMarkdownMemoryImportPreviewItem.Type;

export const AkeruMarkdownMemoryImportPreview = Schema.Struct({
  previewHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  documents: Schema.Array(AkeruMarkdownMemoryImportPreviewItem),
  restoresObservations: Schema.Boolean,
});

export type AkeruMarkdownMemoryImportPreview = typeof AkeruMarkdownMemoryImportPreview.Type;

export const AkeruMarkdownMemoryImportApplyInput = Schema.Struct({
  ...AkeruMarkdownMemoryImportPreviewInput.fields,
  previewHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});

export type AkeruMarkdownMemoryImportApplyInput = typeof AkeruMarkdownMemoryImportApplyInput.Type;

export const AkeruMarkdownMemoryImportApplyResult = Schema.Struct({
  changedDocuments: NonNegativeInt,
  restoredObservations: Schema.Boolean,
});

export type AkeruMarkdownMemoryImportApplyResult = typeof AkeruMarkdownMemoryImportApplyResult.Type;

export const AkeruMemoryArchiveConversation = Schema.Struct({
  threadId: ThreadId,
  snapshot: AkeruConversationMemorySnapshot,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});

export type AkeruMemoryArchiveConversation = typeof AkeruMemoryArchiveConversation.Type;

export const AkeruMemoryArchiveV2 = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  anchorThreadId: ThreadId,
  target: AkeruMemoryArchiveTarget,
  complete: Schema.Boolean,
  createdAt: IsoDateTime,
  files: Schema.Array(AkeruMemoryArchiveFile),
  revisions: Schema.Array(AkeruMemoryArchiveRevision),
  conversations: Schema.Array(AkeruMemoryArchiveConversation),
  manifestSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});

export type AkeruMemoryArchiveV2 = typeof AkeruMemoryArchiveV2.Type;

export const AkeruMemorySnapshot = Schema.Struct({
  threadId: ThreadId,
  durable: Schema.Array(AkeruMemoryRevision),
  histories: Schema.Array(
    Schema.Struct({
      rootId: AkeruMemoryRootId,
      revisions: Schema.Array(AkeruMemoryRevision),
    }),
  ),
  pending: Schema.Array(AkeruMemoryCandidate),
  conversation: AkeruConversationMemorySnapshot,
});

export type AkeruMemorySnapshot = typeof AkeruMemorySnapshot.Type;

export const AkeruMemoryExportInput = Schema.Struct({
  threadId: ThreadId,
  complete: Schema.Boolean,
  target: AkeruMemoryArchiveTarget.pipe(
    Schema.withDecodingDefault(Effect.succeed("thread" as const)),
  ),
});

export type AkeruMemoryExportInput = typeof AkeruMemoryExportInput.Type;

export const AkeruMemoryImportClassification = Schema.Literals([
  "new",
  "changed",
  "conflicting",
  "skipped",
]);

export type AkeruMemoryImportClassification = typeof AkeruMemoryImportClassification.Type;

export const AkeruMemoryImportPreviewItem = Schema.Struct({
  rootId: AkeruMemoryRootId,
  classification: AkeruMemoryImportClassification,
  reason: TrimmedNonEmptyString,
});

export type AkeruMemoryImportPreviewItem = typeof AkeruMemoryImportPreviewItem.Type;

export const AkeruMemoryImportPreviewInput = Schema.Struct({
  threadId: ThreadId,
  target: AkeruMemoryArchiveTarget,
  archive: AkeruMemoryArchiveV2,
});

export type AkeruMemoryImportPreviewInput = typeof AkeruMemoryImportPreviewInput.Type;

export const AkeruMemoryImportPreview = Schema.Struct({
  previewHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  items: Schema.Array(AkeruMemoryImportPreviewItem),
});

export type AkeruMemoryImportPreview = typeof AkeruMemoryImportPreview.Type;

export const AkeruMemoryImportApplyInput = Schema.Struct({
  ...AkeruMemoryImportPreviewInput.fields,
  previewHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  resolutions: Schema.Array(
    Schema.Struct({
      rootId: AkeruMemoryRootId,
      decision: Schema.Literals(["keep-local", "use-archive"]),
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});

export type AkeruMemoryImportApplyInput = typeof AkeruMemoryImportApplyInput.Type;

export const AkeruMemoryImportApplyResult = Schema.Struct({
  imported: NonNegativeInt,
  changed: NonNegativeInt,
  skipped: NonNegativeInt,
});

export type AkeruMemoryImportApplyResult = typeof AkeruMemoryImportApplyResult.Type;
