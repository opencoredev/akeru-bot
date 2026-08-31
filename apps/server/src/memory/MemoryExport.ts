import * as NodeCrypto from "node:crypto";

import {
  AkeruMemoryArchiveV2,
  type AkeruConversationMemorySnapshot,
  type AkeruMemoryArchiveTarget,
  type AkeruMemoryRevision,
  type AkeruMemoryThreadAccess,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { EntityMemoryRepositoryShape } from "./Services/EntityMemoryRepository.ts";
import { resolveMemoryArchivePartitions } from "./EntityMemoryAccess.ts";
import { encodeMemoryArchiveJson } from "./MemoryArchiveJson.ts";

const checksum = (content: string) => NodeCrypto.createHash("sha256").update(content).digest("hex");
const safeName = (value: string) => value.replaceAll(/[^a-zA-Z0-9._-]/g, "_");

const frontmatter = (revision: AkeruMemoryRevision) => ({
  memoryId: revision.rootId,
  revisionId: revision.id,
  revision: revision.revision,
  scope: revision.partition.scope,
  partitionId: revision.partition.partitionId,
  entityKind: revision.entityKind,
  entityId: revision.entityId,
  sourceThreadId: revision.sourceThreadId,
  sourceMessageId: revision.sourceMessageId,
  authorBotId: revision.authorBotId,
  affectedBotIds: revision.affectedBotIds,
  approvalState: revision.approvalState,
  deletionState: revision.deletionState,
  sensitive: revision.sensitive,
  pinned: revision.pinned,
  createdAt: revision.createdAt,
  confirmedAt: revision.confirmedAt,
  updatedAt: revision.updatedAt,
  supersedesId: revision.supersedesId,
  supersededById: revision.supersededById,
});

export const memoryRevisionArchivePath = (revision: AkeruMemoryRevision) =>
  `durable/${safeName(revision.rootId)}/${revision.revision}.md`;

export const renderMemoryRevision = (revision: AkeruMemoryRevision) =>
  `---\nakeru-memory: ${encodeMemoryArchiveJson(frontmatter(revision))}\n---\n\n${revision.fact}\n`;

export function exportAkeruMemory(input: {
  readonly repository: EntityMemoryRepositoryShape;
  readonly access: AkeruMemoryThreadAccess;
  readonly target: AkeruMemoryArchiveTarget;
  readonly complete: boolean;
  readonly createdAt: string;
  readonly conversations: ReadonlyArray<{
    readonly threadId: AkeruMemoryThreadAccess["threadId"];
    readonly snapshot: AkeruConversationMemorySnapshot;
  }>;
}) {
  return Effect.gen(function* () {
    const partitions = yield* resolveMemoryArchivePartitions(input.access, input.target);
    const revisions = yield* input.repository.listByPartitions({
      tenantId: input.access.tenantId,
      partitions,
      complete: input.complete,
    });
    const files = revisions.map((revision) => {
      const content = renderMemoryRevision(revision);
      return {
        path: memoryRevisionArchivePath(revision),
        mediaType: "text/markdown" as const,
        sha256: checksum(content),
        content,
      };
    });
    const revisionRecords = revisions.map((revision) => ({
      revision,
      sha256: checksum(encodeMemoryArchiveJson(revision)),
    }));
    const conversations = input.conversations.map(({ threadId, snapshot }) => ({
      threadId,
      snapshot,
      sha256: checksum(encodeMemoryArchiveJson({ threadId, snapshot })),
    }));
    const manifest = encodeMemoryArchiveJson({
      schemaVersion: 2,
      anchorThreadId: input.access.threadId,
      target: input.target,
      complete: input.complete,
      createdAt: input.createdAt,
      files: files.map(({ path, sha256 }) => ({ path, sha256 })),
      revisions: revisionRecords.map(({ revision, sha256 }) => ({
        id: revision.id,
        rootId: revision.rootId,
        revision: revision.revision,
        sha256,
      })),
      conversations: conversations.map(({ threadId, sha256 }) => ({ threadId, sha256 })),
    });
    return yield* Schema.decodeUnknownEffect(AkeruMemoryArchiveV2)({
      schemaVersion: 2,
      anchorThreadId: input.access.threadId,
      target: input.target,
      complete: input.complete,
      createdAt: input.createdAt,
      files,
      revisions: revisionRecords,
      conversations,
      manifestSha256: checksum(manifest),
    });
  });
}
