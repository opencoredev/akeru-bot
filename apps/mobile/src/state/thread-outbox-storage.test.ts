import { describe, expect, it } from "@effect/vitest";
import { MessageId, ProjectId } from "@akeru/contracts";
import { AtomRegistry } from "effect/unstable/reactivity";
import { onTestFinished, vi } from "vite-plus/test";
import {
  encodeQueuedThreadMessage,
  flattenQueuedThreadMessages,
  resolveThreadOutboxDeliveryAction,
  type QueuedThreadMessage,
} from "./thread-outbox-model";
import { createThreadOutboxManager } from "./thread-outbox-manager";
import { expoThreadOutboxStorage, ThreadOutboxStorageError } from "./thread-outbox-storage";
import { queuedMessage } from "./thread-outbox.test-support";

const outboxFiles = vi.hoisted(() => new Map<string, string | Error>());

vi.mock("expo-file-system", () => {
  class File {
    constructor(readonly name: string) {}

    async text(): Promise<string> {
      const contents = outboxFiles.get(this.name);

      if (contents instanceof Error) throw contents;

      if (contents === undefined) throw new Error("Missing file");

      return contents;
    }
  }

  return {
    File,
    Directory: class {
      create() {}

      list() {
        return Array.from(outboxFiles.keys(), (name) => new File(name));
      }
    },
    Paths: { document: "/documents" },
  };
});

describe("thread outbox storage", () => {
  it.each(["read", "json", "schema"] as const)(
    "hydrates valid queued messages after a record %s failure and keeps the unread file",
    async (failure) => {
      onTestFinished(() => outboxFiles.clear());

      const first = queuedMessage({
        messageId: "message-1",
        createdAt: "2026-06-08T10:00:01.000Z",
      });

      const second = queuedMessage({
        messageId: "message-2",
        createdAt: "2026-06-08T10:00:02.000Z",
      });

      const corruptContents =
        failure === "read"
          ? new Error("storage unavailable")
          : failure === "json"
            ? "{"
            : JSON.stringify({ ...second, schemaVersion: 999 });

      outboxFiles.set("message-1.json", JSON.stringify(encodeQueuedThreadMessage(first)));
      outboxFiles.set("message-2.json", corruptContents);

      const loaded = await expoThreadOutboxStorage.load();
      expect(loaded.messages).toEqual([first]);
      expect(loaded.unreadRecords).toMatchObject([
        { operation: "read-message", fileName: "message-2.json" },
      ]);
      expect(outboxFiles.get("message-2.json")).toBe(corruptContents);

      outboxFiles.set("message-2.json", JSON.stringify(encodeQueuedThreadMessage(second)));
      await expect(expoThreadOutboxStorage.load()).resolves.toEqual({
        messages: [first, second],
        unreadRecords: [],
      });
    },
  );

  it("publishes readable queued messages while reporting unread records", async () => {
    const registry = AtomRegistry.make();
    onTestFinished(() => registry.dispose());

    const readable = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    const unread = new ThreadOutboxStorageError({
      operation: "read-message",
      environmentId: null,
      threadId: null,
      messageId: null,
      fileName: "message-2.json",
      cause: new Error("storage unavailable"),
    });

    const warnings: Array<{ message: string; error: unknown }> = [];

    const manager = createThreadOutboxManager({
      registry,
      warn: (message, error) => warnings.push({ message, error }),
      storage: {
        load: async () => ({ messages: [readable], unreadRecords: [unread] }),
        write: async () => undefined,
        remove: async () => undefined,
      },
    });

    await expect(manager.load()).resolves.toBe(false);

    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [readable],
    });
    expect(warnings).toEqual([
      { message: "[thread-outbox] left unreadable persisted message on disk", error: unread },
    ]);
  });

  it("retries a mixed load so a later-readable record can join the drain queue", async () => {
    const registry = AtomRegistry.make();
    onTestFinished(() => registry.dispose());

    const first = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    const second = queuedMessage({
      messageId: "message-2",
      createdAt: "2026-06-08T10:00:02.000Z",
    });

    const unread = new ThreadOutboxStorageError({
      operation: "read-message",
      environmentId: null,
      threadId: null,
      messageId: null,
      fileName: "message-2.json",
      cause: new Error("{"),
    });

    let loadCalls = 0;

    const manager = createThreadOutboxManager({
      registry,
      warn: () => {},
      storage: {
        load: async () => {
          loadCalls += 1;

          if (loadCalls === 1) {
            return { messages: [first], unreadRecords: [unread] };
          }

          return { messages: [first, second], unreadRecords: [] };
        },
        write: async () => undefined,
        remove: async () => undefined,
      },
    });

    await expect(manager.load()).resolves.toBe(false);
    expect(
      flattenQueuedThreadMessages(registry.get(manager.queuedMessagesByThreadKeyAtom)),
    ).toEqual([first]);
    expect(loadCalls).toBe(1);

    await expect(manager.load()).resolves.toBe(true);
    expect(loadCalls).toBe(2);
    expect(
      flattenQueuedThreadMessages(registry.get(manager.queuedMessagesByThreadKeyAtom)),
    ).toEqual([first, second]);

    await expect(manager.load()).resolves.toBe(true);
    expect(loadCalls).toBe(2);
  });

  it("makes a readable pending task visible to drain after a mixed valid/corrupt load", async () => {
    onTestFinished(() => outboxFiles.clear());
    const registry = AtomRegistry.make();
    onTestFinished(() => registry.dispose());

    const pendingTask = {
      ...queuedMessage({
        messageId: "message-1",
        createdAt: "2026-06-08T10:00:01.000Z",
      }),
      text: "Retry the upload worker",
      creation: {
        projectId: ProjectId.make("project-1"),
        workspaceMode: "local" as const,
        branch: null,
        worktreePath: null,
      },
    };

    outboxFiles.set("message-1.json", JSON.stringify(encodeQueuedThreadMessage(pendingTask)));
    outboxFiles.set("message-2.json", "{");

    const manager = createThreadOutboxManager({
      registry,
      warn: () => {},
      storage: expoThreadOutboxStorage,
    });

    await manager.load();

    const visible = flattenQueuedThreadMessages(
      registry.get(manager.queuedMessagesByThreadKeyAtom),
    );

    expect(visible).toEqual([pendingTask]);
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: true,
        threadExists: false,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: false,
      }),
    ).toBe("send");
    expect(outboxFiles.get("message-2.json")).toBe("{");
    expect(outboxFiles.has("message-1.json")).toBe(true);

    await expect(manager.clearEnvironment(pendingTask.environmentId)).rejects.toMatchObject({
      operation: "clear-environment-load",
    });
    expect(outboxFiles.get("message-2.json")).toBe("{");
    expect(JSON.parse(outboxFiles.get("message-1.json") as string)).toMatchObject({
      messageId: pendingTask.messageId,
      text: pendingTask.text,
    });
  });

  it("preserves queued messages when environment cleanup cannot read the outbox", async () => {
    const registry = AtomRegistry.make();
    onTestFinished(() => registry.dispose());

    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    const stored = new Map<MessageId, QueuedThreadMessage>();

    const manager = createThreadOutboxManager({
      registry,
      warn: () => {},
      storage: {
        load: async () => {
          throw new Error("storage unavailable");
        },
        write: async (entry) => {
          stored.set(entry.messageId, entry);
        },
        remove: async (entry) => {
          stored.delete(entry.messageId);
        },
      },
    });

    await manager.enqueue(message);

    await expect(manager.clearEnvironment(message.environmentId)).rejects.toMatchObject({
      operation: "clear-environment-load",
    });
    expect([...stored.values()]).toEqual([message]);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [message],
    });
  });

  it("preserves queued messages when environment cleanup sees an unread outbox record", async () => {
    const registry = AtomRegistry.make();
    onTestFinished(() => registry.dispose());

    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    const unread = new ThreadOutboxStorageError({
      operation: "read-message",
      environmentId: null,
      threadId: null,
      messageId: null,
      fileName: "message-2.json",
      cause: new Error("{"),
    });

    const stored = new Map<MessageId, QueuedThreadMessage>();

    const manager = createThreadOutboxManager({
      registry,
      warn: () => {},
      storage: {
        load: async () => ({ messages: [message], unreadRecords: [unread] }),
        write: async (entry) => {
          stored.set(entry.messageId, entry);
        },
        remove: async (entry) => {
          stored.delete(entry.messageId);
        },
      },
    });

    await manager.enqueue(message);

    await expect(manager.clearEnvironment(message.environmentId)).rejects.toMatchObject({
      operation: "clear-environment-load",
      cause: [unread],
    });
    expect([...stored.values()]).toEqual([message]);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [message],
    });
  });
});
