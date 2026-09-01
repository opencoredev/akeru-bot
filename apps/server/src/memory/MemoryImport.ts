import * as NodeCrypto from "node:crypto";

import type {
  AkeruMemoryArchive,
  AkeruMemoryArchiveTarget,
  AkeruMemoryImportApplyResult,
  AkeruMemoryImportPreview,
  AkeruMemoryRevision,
  AkeruMemoryThreadAccess,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { resolveMemoryArchivePartitions } from "./EntityMemoryAccess.ts";
import { memoryRevisionArchivePath, renderMemoryRevision } from "./MemoryExport.ts";
import { encodeMemoryArchiveJson } from "./MemoryArchiveJson.ts";
import {
  EntityMemoryImportError,
  type EntityMemoryRepositoryShape,
} from "./Services/EntityMemoryRepository.ts";

const checksum = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");

const prepare = Effect.fn("MemoryImport.prepare")(function* (input: {
  readonly repository: EntityMemoryRepositoryShape;
  readonly access: AkeruMemoryThreadAccess;
  readonly target: AkeruMemoryArchiveTarget;
  readonly archive: AkeruMemoryArchive;
}) {
  if (input.archive.schemaVersion !== 2) {
    return yield* new EntityMemoryImportError({
      detail: "Version 1 memory archives are readable exports and cannot be imported safely.",
    });
  }
  if (input.archive.target !== input.target) {
    return yield* new EntityMemoryImportError({
      detail: "The selected import target does not match the archive target.",
    });
  }
  if (!input.archive.complete) {
    return yield* new EntityMemoryImportError({
      detail:
        "A current-state archive has no complete revision chain and cannot be imported safely.",
    });
  }
  const importTarget =
    input.target === "all"
      ? yield* new EntityMemoryImportError({
          detail:
            "All-memory archives span separate authority domains. Import a thread, bot, project, or workspace archive instead.",
        })
      : input.target;
  if (input.archive.files.some((file) => checksum(file.content) !== file.sha256)) {
    return yield* new EntityMemoryImportError({ detail: "A memory archive file checksum failed." });
  }
  if (
    input.archive.revisions.some(
      ({ revision, sha256 }) => checksum(encodeMemoryArchiveJson(revision)) !== sha256,
    )
  ) {
    return yield* new EntityMemoryImportError({
      detail: "A structured memory revision checksum failed.",
    });
  }
  if (
    input.archive.conversations.some(
      ({ threadId, snapshot, sha256 }) =>
        checksum(encodeMemoryArchiveJson({ threadId, snapshot })) !== sha256,
    )
  ) {
    return yield* new EntityMemoryImportError({
      detail: "A conversation memory checksum failed.",
    });
  }
  const manifest = encodeMemoryArchiveJson({
    schemaVersion: 2,
    anchorThreadId: input.archive.anchorThreadId,
    target: input.archive.target,
    complete: input.archive.complete,
    createdAt: input.archive.createdAt,
    files: input.archive.files.map(({ path, sha256 }) => ({ path, sha256 })),
    revisions: input.archive.revisions.map(({ revision, sha256 }) => ({
      id: revision.id,
      rootId: revision.rootId,
      revision: revision.revision,
      sha256,
    })),
    conversations: input.archive.conversations.map(({ threadId, sha256 }) => ({
      threadId,
      sha256,
    })),
  });
  if (checksum(manifest) !== input.archive.manifestSha256) {
    return yield* new EntityMemoryImportError({
      detail: "The memory archive manifest is invalid.",
    });
  }
  if (
    input.archive.files.length !== input.archive.revisions.length ||
    input.archive.revisions.some(({ revision }) => {
      const file = input.archive.files.find(
        (candidate) => candidate.path === memoryRevisionArchivePath(revision),
      );
      return file === undefined || file.content !== renderMemoryRevision(revision);
    })
  ) {
    return yield* new EntityMemoryImportError({
      detail: "The readable memory files do not match the structured revision records.",
    });
  }
  const revisionsByRoot = new Map<string, Array<AkeruMemoryRevision>>();
  for (const { revision } of input.archive.revisions) {
    const revisions = revisionsByRoot.get(revision.rootId) ?? [];
    revisions.push(revision);
    revisionsByRoot.set(revision.rootId, revisions);
  }
  for (const revisions of revisionsByRoot.values()) {
    const ordered = [...revisions].sort((left, right) => left.revision - right.revision);
    if (ordered.some((revision) => revision.approvalState !== "approved")) {
      return yield* new EntityMemoryImportError({
        detail: "Every imported memory revision must already be approved.",
      });
    }
    if (ordered.some((revision) => revision.deletionState === "deleted")) {
      return yield* new EntityMemoryImportError({
        detail: "Deleted memory revisions cannot be restored from an archive.",
      });
    }
    const terminalIndex = ordered.findIndex((revision) => revision.deletionState === "tombstoned");
    if (terminalIndex >= 0 && terminalIndex !== ordered.length - 1) {
      return yield* new EntityMemoryImportError({
        detail: "A tombstoned memory revision must be the terminal archive revision.",
      });
    }
  }
  const resolvedPartitions = yield* resolveMemoryArchivePartitions(input.access, importTarget);
  const partitions =
    importTarget === "workspace" ? resolvedPartitions.slice(0, 1) : resolvedPartitions;
  return {
    partitions,
    revisions: input.archive.revisions.map(({ revision }) => revision),
  };
});

export function previewAkeruMemoryImport(input: {
  readonly repository: EntityMemoryRepositoryShape;
  readonly access: AkeruMemoryThreadAccess;
  readonly target: AkeruMemoryArchiveTarget;
  readonly archive: AkeruMemoryArchive;
}): Effect.Effect<AkeruMemoryImportPreview, Error> {
  return Effect.gen(function* () {
    const prepared = yield* prepare(input);
    return yield* input.repository.previewImport({ access: input.access, ...prepared });
  });
}

export function applyAkeruMemoryImport(input: {
  readonly repository: EntityMemoryRepositoryShape;
  readonly access: AkeruMemoryThreadAccess;
  readonly target: AkeruMemoryArchiveTarget;
  readonly archive: AkeruMemoryArchive;
  readonly previewHash: string;
}): Effect.Effect<AkeruMemoryImportApplyResult, Error> {
  return Effect.gen(function* () {
    const prepared = yield* prepare(input);
    return yield* input.repository.applyImport({
      access: input.access,
      ...prepared,
      previewHash: input.previewHash,
    });
  });
}
