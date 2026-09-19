// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, describe, expect, it, vi } from "@effect/vitest";
import { BotId, GroupId, ThreadId, type AkeruConversationMemorySnapshot } from "@t3tools/contracts";

import { BotMemoryStore } from "./BotMemory.ts";
import {
  applyBotMemoryImport,
  exportBotMemoryArchive,
  previewBotMemoryImport,
} from "./BotMemoryArchive.ts";

const NodeFS = NodeFSP;

const directories: string[] = [];
const access = {
  botId: BotId.make("bot-1"),
  groupId: GroupId.make("group-1"),
  groupMemberBotIds: [BotId.make("bot-1")],
};
const emptyConversation: AkeruConversationMemorySnapshot = { current: null, history: [] };
const conversation: AkeruConversationMemorySnapshot = {
  current: {
    id: "observation-1",
    generationCount: 1,
    originType: "initial",
    activeObservations: "The release is Tuesday.",
    bufferedObservations: "",
    bufferedReflection: null,
    totalTokensObserved: 100,
    observationTokenCount: 6,
    createdAt: "2026-09-13T12:00:00.000Z",
    updatedAt: "2026-09-13T12:01:00.000Z",
  },
  history: [],
};

async function fixture() {
  const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "akeru-archive-"));
  directories.push(directory);
  return new BotMemoryStore(NodePath.join(directory, "userdata"));
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => NodeFS.rm(directory, { recursive: true })),
  );
});

describe("Markdown memory archive", () => {
  it("exports checksummed USER.md, MEMORY.md, GROUP.md, and observations", async () => {
    const store = await fixture();
    await store.replaceDocument(access, "user", "Leo prefers concise answers.");
    await store.replaceDocument(access, "memory", "Verify changes before reporting them.");
    await store.replaceDocument(access, "group", "This group owns the release.");

    const archive = await exportBotMemoryArchive({
      store,
      access,
      threadId: ThreadId.make("thread-1"),
      conversation,
      createdAt: "2026-09-13T12:02:00.000Z",
    });

    assert.equal(archive.schemaVersion, 3);
    assert.deepEqual(
      archive.documents.map((document) => document.path),
      ["bots/bot-1/USER.md", "bots/bot-1/MEMORY.md", "bots/bot-1/groups/group-1/GROUP.md"],
    );
    assert.equal(
      archive.conversation.snapshot.current?.activeObservations,
      "The release is Tuesday.",
    );
  });

  it("previews and applies documents and observational memory", async () => {
    const source = await fixture();
    await source.replaceDocument(access, "user", "Imported user context.");
    await source.replaceDocument(access, "group", "Imported group context.");
    const archive = await exportBotMemoryArchive({
      store: source,
      access,
      threadId: ThreadId.make("thread-1"),
      conversation,
      createdAt: "2026-09-13T12:02:00.000Z",
    });
    const destination = await fixture();
    const preview = await previewBotMemoryImport({
      store: destination,
      access,
      threadId: ThreadId.make("thread-1"),
      archive,
      currentConversation: emptyConversation,
    });
    const restoreConversation = vi.fn(async () => undefined);

    const result = await applyBotMemoryImport({
      store: destination,
      access,
      threadId: ThreadId.make("thread-1"),
      archive,
      currentConversation: emptyConversation,
      previewHash: preview.previewHash,
      restoreConversation,
    });

    assert.equal(result.changedDocuments, 2);
    assert.isTrue(result.restoredObservations);
    assert.equal(
      (await destination.readDocument(access, "user")).content,
      "Imported user context.",
    );
    assert.equal(
      (await destination.readDocument(access, "group")).content,
      "Imported group context.",
    );
    expect(restoreConversation).toHaveBeenCalledWith(conversation);
  });

  it("rejects cross-chat imports before changing notes or clearing observations", async () => {
    const store = await fixture();
    const archive = await exportBotMemoryArchive({
      store,
      access,
      threadId: ThreadId.make("thread-1"),
      conversation,
      createdAt: "2026-09-13T12:02:00.000Z",
    });
    await store.replaceDocument(access, "memory", "Keep these destination notes.");
    const restoreConversation = vi.fn(async () => undefined);
    const input = {
      store,
      access,
      threadId: ThreadId.make("thread-2"),
      archive,
      currentConversation: conversation,
    };
    await expect(previewBotMemoryImport(input)).rejects.toMatchObject({ code: "access-denied" });
    await expect(
      applyBotMemoryImport({ ...input, previewHash: "unused", restoreConversation }),
    ).rejects.toMatchObject({ code: "access-denied" });
    expect(restoreConversation).not.toHaveBeenCalled();
    assert.equal(
      (await store.readDocument(access, "memory")).content,
      "Keep these destination notes.",
    );
  });

  it("rejects tampering and stale previews", async () => {
    const store = await fixture();
    const archive = await exportBotMemoryArchive({
      store,
      access,
      threadId: ThreadId.make("thread-1"),
      conversation,
      createdAt: "2026-09-13T12:02:00.000Z",
    });
    const tampered = {
      ...archive,
      documents: archive.documents.map((document, index) =>
        index === 0 ? { ...document, content: "tampered" } : document,
      ),
    };
    await expect(
      previewBotMemoryImport({
        store,
        access,
        threadId: ThreadId.make("thread-1"),
        archive: tampered,
        currentConversation: conversation,
      }),
    ).rejects.toMatchObject({ code: "io-error" });

    const preview = await previewBotMemoryImport({
      store,
      access,
      threadId: ThreadId.make("thread-1"),
      archive,
      currentConversation: emptyConversation,
    });
    await store.replaceDocument(access, "memory", "Changed after preview.");
    await expect(
      applyBotMemoryImport({
        store,
        access,
        threadId: ThreadId.make("thread-1"),
        archive,
        currentConversation: emptyConversation,
        previewHash: preview.previewHash,
        restoreConversation: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: "invalid-operation" });
  });
});
