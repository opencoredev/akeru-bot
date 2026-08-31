import type {
  AkeruMemoryId,
  AkeruMemoryRevision,
  AkeruMemoryRootId,
  AkeruMemoryThreadAccess,
  AkeruMemoryImportPreview,
  AkeruMemoryImportApplyResult,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type { AkeruMemoryAccessDenied } from "../EntityMemoryAccess.ts";
import type { AuthorizedMemoryPartition } from "../EntityMemoryAccess.ts";

export class EntityMemoryConflictError extends Schema.TaggedErrorClass<EntityMemoryConflictError>()(
  "EntityMemoryConflictError",
  {
    rootId: Schema.String,
    expectedRevision: Schema.Number,
    actualRevision: Schema.NullOr(Schema.Number),
  },
) {
  override get message(): string {
    return `Memory revision conflict for ${this.rootId}. Expected ${this.expectedRevision}, found ${this.actualRevision ?? "none"}.`;
  }
}

export class EntityMemoryNotFoundError extends Schema.TaggedErrorClass<EntityMemoryNotFoundError>()(
  "EntityMemoryNotFoundError",
  { rootId: Schema.String },
) {
  override get message(): string {
    return `Memory ${this.rootId} does not exist.`;
  }
}

export interface SearchEntityMemoryInput {
  readonly access: AkeruMemoryThreadAccess;
  readonly query: string;
  readonly limit: number;
}

export interface GetEntityMemoryInput {
  readonly access: AkeruMemoryThreadAccess;
  readonly rootId: AkeruMemoryRootId;
}

export interface ListEntityMemoryInput {
  readonly access: AkeruMemoryThreadAccess;
}

export interface ListEntityMemoryPartitionsInput {
  readonly tenantId: AkeruMemoryThreadAccess["tenantId"];
  readonly partitions: ReadonlyArray<AuthorizedMemoryPartition>;
  readonly complete: boolean;
}

export interface DeleteEntityMemoryInput extends GetEntityMemoryInput {}

export interface InsertEntityMemoryInput {
  readonly access: AkeruMemoryThreadAccess;
  readonly revision: AkeruMemoryRevision;
}

export interface ReviseEntityMemoryInput extends InsertEntityMemoryInput {
  readonly expectedRevision: number;
}

export interface TombstoneEntityMemoryInput {
  readonly access: AkeruMemoryThreadAccess;
  readonly rootId: AkeruMemoryRootId;
  readonly expectedRevision: number;
  readonly memoryId: AkeruMemoryId;
  readonly updatedAt: string;
}

export interface ImportEntityMemoryInput {
  readonly access: AkeruMemoryThreadAccess;
  readonly partitions: ReadonlyArray<AuthorizedMemoryPartition>;
  readonly revisions: ReadonlyArray<AkeruMemoryRevision>;
}

export interface ApplyEntityMemoryImportInput extends ImportEntityMemoryInput {
  readonly previewHash: string;
}

export interface EntityMemoryDerivedCopy {
  readonly tenantId: AkeruMemoryThreadAccess["tenantId"];
  readonly rootId: AkeruMemoryRootId;
  readonly revisionId: AkeruMemoryId;
  readonly threadId: ThreadId;
}

export class EntityMemoryImportError extends Schema.TaggedErrorClass<EntityMemoryImportError>()(
  "EntityMemoryImportError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export type EntityMemoryRepositoryError =
  | ProjectionRepositoryError
  | AkeruMemoryAccessDenied
  | EntityMemoryConflictError
  | EntityMemoryNotFoundError
  | EntityMemoryImportError;

export interface EntityMemoryRepositoryShape {
  readonly insert: (
    input: InsertEntityMemoryInput,
  ) => Effect.Effect<AkeruMemoryRevision, EntityMemoryRepositoryError>;
  readonly revise: (
    input: ReviseEntityMemoryInput,
  ) => Effect.Effect<AkeruMemoryRevision, EntityMemoryRepositoryError>;
  readonly tombstone: (
    input: TombstoneEntityMemoryInput,
  ) => Effect.Effect<AkeruMemoryRevision, EntityMemoryRepositoryError>;
  readonly getCurrent: (
    input: GetEntityMemoryInput,
  ) => Effect.Effect<AkeruMemoryRevision, EntityMemoryRepositoryError>;
  readonly search: (
    input: SearchEntityMemoryInput,
  ) => Effect.Effect<ReadonlyArray<AkeruMemoryRevision>, EntityMemoryRepositoryError>;
  readonly listCurrent: (
    input: ListEntityMemoryInput,
  ) => Effect.Effect<ReadonlyArray<AkeruMemoryRevision>, EntityMemoryRepositoryError>;
  readonly listHistory: (
    input: GetEntityMemoryInput,
  ) => Effect.Effect<ReadonlyArray<AkeruMemoryRevision>, EntityMemoryRepositoryError>;
  readonly listByPartitions: (
    input: ListEntityMemoryPartitionsInput,
  ) => Effect.Effect<ReadonlyArray<AkeruMemoryRevision>, EntityMemoryRepositoryError>;
  readonly previewImport?: (
    input: ImportEntityMemoryInput,
  ) => Effect.Effect<AkeruMemoryImportPreview, EntityMemoryRepositoryError>;
  readonly applyImport?: (
    input: ApplyEntityMemoryImportInput,
  ) => Effect.Effect<AkeruMemoryImportApplyResult, EntityMemoryRepositoryError>;
  readonly deleteRoot: (
    input: DeleteEntityMemoryInput,
  ) => Effect.Effect<void, EntityMemoryRepositoryError>;
  readonly recordDerivedCopies?: (input: {
    readonly tenantId: AkeruMemoryThreadAccess["tenantId"];
    readonly threadId: ThreadId;
    readonly revisions: ReadonlyArray<{
      readonly rootId: AkeruMemoryRootId;
      readonly revisionId: AkeruMemoryId;
    }>;
    readonly createdAt: string;
  }) => Effect.Effect<void, EntityMemoryRepositoryError>;
  readonly listDerivedCopies?: (input: {
    readonly tenantId: AkeruMemoryThreadAccess["tenantId"];
    readonly rootId: AkeruMemoryRootId;
  }) => Effect.Effect<ReadonlyArray<EntityMemoryDerivedCopy>, EntityMemoryRepositoryError>;
  readonly listPendingDerivedCopies?: () => Effect.Effect<
    ReadonlyArray<EntityMemoryDerivedCopy>,
    EntityMemoryRepositoryError
  >;
  readonly removeDerivedCopy?: (
    input: Omit<EntityMemoryDerivedCopy, "revisionId">,
  ) => Effect.Effect<void, EntityMemoryRepositoryError>;
}

export class EntityMemoryRepository extends Context.Service<
  EntityMemoryRepository,
  EntityMemoryRepositoryShape
>()("akeru-bot/memory/Services/EntityMemoryRepository") {}
