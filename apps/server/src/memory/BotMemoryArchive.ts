import * as NodeCrypto from "node:crypto";

import {
  AkeruMarkdownMemoryArchiveV3,
  type AkeruConversationMemorySnapshot,
  type AkeruMarkdownMemoryArchiveV3 as AkeruMarkdownMemoryArchiveV3Value,
  type AkeruMarkdownMemoryImportApplyResult,
  type AkeruMarkdownMemoryImportPreview,
  type AkeruMemoryDocumentTarget,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { BotMemoryError, type BotMemoryAccess, type BotMemoryStore } from "./BotMemory.ts";
import { encodeMemoryArchiveJson } from "./MemoryArchiveJson.ts";

const checksum = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const decodeArchive = Schema.decodeUnknownSync(AkeruMarkdownMemoryArchiveV3);

const documentPath = (access: BotMemoryAccess, target: AkeruMemoryDocumentTarget): string =>
  target === "user"
    ? `bots/${access.botId}/USER.md`
    : target === "memory"
      ? `bots/${access.botId}/MEMORY.md`
      : `bots/${access.botId}/groups/${access.groupId}/GROUP.md`;

const manifestValue = (archive: Omit<AkeruMarkdownMemoryArchiveV3Value, "manifestSha256">) =>
  encodeMemoryArchiveJson({
    schemaVersion: archive.schemaVersion,
    anchorThreadId: archive.anchorThreadId,
    botId: archive.botId,
    groupId: archive.groupId,
    createdAt: archive.createdAt,
    documents: archive.documents.map(({ botId, groupId, target, path, sha256 }) => ({
      botId,
      groupId,
      target,
      path,
      sha256,
    })),
    conversation: { sha256: archive.conversation.sha256 },
  });

export async function exportBotMemoryArchive(input: {
  readonly store: BotMemoryStore;
  readonly access: BotMemoryAccess;
  readonly threadId: ThreadId;
  readonly conversation: AkeruConversationMemorySnapshot;
  readonly createdAt: string;
}): Promise<AkeruMarkdownMemoryArchiveV3Value> {
  const snapshot = await input.store.readSnapshot(input.access);
  const documents = [
    snapshot.user,
    snapshot.memory,
    ...(snapshot.group ? [snapshot.group] : []),
  ].map((document) => ({
    botId: input.access.botId,
    groupId: document.target === "group" ? input.access.groupId : null,
    target: document.target,
    path: documentPath(input.access, document.target),
    content: document.content,
    sha256: checksum(document.content),
  }));
  const conversation = {
    snapshot: input.conversation,
    sha256: checksum(encodeMemoryArchiveJson(input.conversation)),
  };
  const withoutManifest = {
    schemaVersion: 3 as const,
    anchorThreadId: input.threadId,
    botId: input.access.botId,
    groupId: input.access.groupId,
    createdAt: input.createdAt,
    documents,
    conversation,
  };
  return decodeArchive({
    ...withoutManifest,
    manifestSha256: checksum(manifestValue(withoutManifest)),
  });
}

async function prepareImport(input: {
  readonly store: BotMemoryStore;
  readonly access: BotMemoryAccess;
  readonly threadId: ThreadId;
  readonly archive: AkeruMarkdownMemoryArchiveV3Value;
  readonly currentConversation: AkeruConversationMemorySnapshot;
}) {
  const { archive, access } = input;
  if (archive.anchorThreadId !== input.threadId) {
    throw new BotMemoryError("access-denied", "Restore this memory archive in its original chat.");
  }
  if (String(archive.botId) !== String(access.botId)) {
    throw new BotMemoryError("access-denied", "The archive belongs to a different bot.");
  }
  if (String(archive.groupId) !== String(access.groupId)) {
    throw new BotMemoryError(
      "access-denied",
      "The archive group does not match the active conversation group.",
    );
  }
  if (
    checksum(encodeMemoryArchiveJson(archive.conversation.snapshot)) !== archive.conversation.sha256
  ) {
    throw new BotMemoryError("io-error", "The observational-memory checksum is invalid.");
  }
  if (checksum(manifestValue(archive)) !== archive.manifestSha256) {
    throw new BotMemoryError("io-error", "The memory archive manifest checksum is invalid.");
  }

  const expectedTargets = new Set<AkeruMemoryDocumentTarget>([
    "user",
    "memory",
    ...(access.groupId === null ? [] : (["group"] as const)),
  ]);
  if (archive.documents.length !== expectedTargets.size) {
    throw new BotMemoryError("invalid-operation", "The memory archive has missing or extra files.");
  }
  const seen = new Set<AkeruMemoryDocumentTarget>();
  const current = await input.store.readSnapshot(access);
  const currentByTarget = new Map(
    [current.user, current.memory, ...(current.group ? [current.group] : [])].map((document) => [
      document.target,
      document,
    ]),
  );
  const prepared = archive.documents.map((document) => {
    if (!expectedTargets.has(document.target) || seen.has(document.target)) {
      throw new BotMemoryError(
        "invalid-operation",
        "The memory archive contains an invalid file set.",
      );
    }
    seen.add(document.target);
    const expectedGroupId = document.target === "group" ? access.groupId : null;
    if (
      String(document.botId) !== String(access.botId) ||
      String(document.groupId) !== String(expectedGroupId) ||
      document.path !== documentPath(access, document.target) ||
      checksum(document.content) !== document.sha256
    ) {
      throw new BotMemoryError("io-error", `The ${document.target} memory file failed validation.`);
    }
    const validated = input.store.validateDocumentReplacement(
      access,
      document.target,
      document.content,
    );
    const existing = currentByTarget.get(document.target)!;
    return {
      target: document.target,
      content: validated.normalized,
      charCount: validated.normalized.length,
      charLimit: validated.charLimit,
      classification:
        existing.content === validated.normalized
          ? ("unchanged" as const)
          : existing.content.length === 0
            ? ("new" as const)
            : ("changed" as const),
    };
  });
  const currentStateChecksum = checksum(
    encodeMemoryArchiveJson({
      documents: [...currentByTarget.values()].map(({ target, content }) => ({ target, content })),
      conversation: input.currentConversation,
    }),
  );
  const observationsChanged =
    encodeMemoryArchiveJson(input.currentConversation) !==
    encodeMemoryArchiveJson(archive.conversation.snapshot);
  return {
    prepared,
    observationsChanged,
    previewHash: checksum(`${archive.manifestSha256}:${currentStateChecksum}`),
  };
}

export async function previewBotMemoryImport(input: {
  readonly store: BotMemoryStore;
  readonly access: BotMemoryAccess;
  readonly threadId: ThreadId;
  readonly archive: AkeruMarkdownMemoryArchiveV3Value;
  readonly currentConversation: AkeruConversationMemorySnapshot;
}): Promise<AkeruMarkdownMemoryImportPreview> {
  const prepared = await prepareImport(input);
  return {
    previewHash: prepared.previewHash,
    documents: prepared.prepared.map(({ content: _content, ...document }) => document),
    restoresObservations: prepared.observationsChanged,
  };
}

export async function applyBotMemoryImport(input: {
  readonly store: BotMemoryStore;
  readonly access: BotMemoryAccess;
  readonly threadId: ThreadId;
  readonly archive: AkeruMarkdownMemoryArchiveV3Value;
  readonly currentConversation: AkeruConversationMemorySnapshot;
  readonly previewHash: string;
  /** Restores or rolls back atomically, rejecting a stale expected snapshot before mutation. */
  readonly restoreConversation: (
    snapshot: AkeruConversationMemorySnapshot,
    expectedSnapshot: AkeruConversationMemorySnapshot,
  ) => Promise<void>;
}): Promise<AkeruMarkdownMemoryImportApplyResult> {
  return input.store.withDocumentTransaction(input.access, async (replace) => {
    const prepared = await prepareImport(input);
    if (prepared.previewHash !== input.previewHash) {
      throw new BotMemoryError(
        "invalid-operation",
        "Memory changed after the import preview. Preview the archive again.",
      );
    }
    let changedDocuments = 0;
    for (const document of prepared.prepared) {
      if (document.classification === "unchanged") continue;
      await replace(document.target, document.content);
      changedDocuments += 1;
    }
    if (prepared.observationsChanged) {
      await input.restoreConversation(
        input.archive.conversation.snapshot,
        input.currentConversation,
      );
    }
    return { changedDocuments, restoredObservations: prepared.observationsChanged };
  });
}
