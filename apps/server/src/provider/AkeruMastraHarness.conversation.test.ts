import { partialSdkFixture } from "./test-support/partialSdkFixture.ts";
import { describe } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { AuthStorage } from "@mastra/code-sdk/auth/storage";
import type { MastraDBMessage } from "@mastra/core/agent-controller";
import { MessageList } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { ObservationalMemory } from "@mastra/memory/processors";
import * as DateTime from "effect/DateTime";
import { it } from "@effect/vitest";
import { assert, expect, vi } from "vite-plus/test";
import {
  AkeruPassiveObservationalMemoryProcessor,
  createAkeruMastraMemory,
} from "./AkeruMastraHarness.ts";
import { AKERU_RECENT_TURN_LIMIT } from "./RecentConversation.ts";

describe("AkeruMastraHarness", () => {
  it("restores a bounded recent message window after reopening", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-message-store-"));

    const options = {
      authStorage: new AuthStorage(NodePath.join(directory, "auth.json")),
      memoryDbPath: NodePath.join(directory, "observational-memory.sqlite"),
    };

    try {
      const first = await createAkeruMastraMemory(options);
      await first.memory.createThread({
        threadId: "thread-history",
        resourceId: "thread-history",
      });

      const messages = Array.from({ length: (AKERU_RECENT_TURN_LIMIT + 2) * 2 }, (_, index) => ({
        id: `message-${index}`,
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        createdAt: DateTime.toDate(
          DateTime.add(DateTime.makeUnsafe("2026-08-30T20:00:00.000Z"), { minutes: index }),
        ),
        content: { format: 2 as const, parts: [{ type: "text" as const, text: `Turn ${index}` }] },
        threadId: "thread-history",
        resourceId: "thread-history",
      }));

      await first.memory.persistMessages(messages);
      await first.close();

      const reopened = await createAkeruMastraMemory(options);

      const engine = partialSdkFixture<ObservationalMemory>({
        getThreadContext: vi.fn(() => ({
          threadId: "thread-history",
          resourceId: "thread-history",
        })),
        loadUnobservedMessages: vi.fn(async () => []),
        getOrCreateRecord: vi.fn(async () => ({ activeObservations: "Older observations." })),
        buildContextSystemMessages: vi.fn(async () => ["Older context from observations."]),
      });

      const processor = new AkeruPassiveObservationalMemoryProcessor(engine, reopened.memory);

      const messageList = new MessageList({
        threadId: "thread-history",
        resourceId: "thread-history",
      });

      messageList.add(
        {
          id: "current-message",
          role: "user",
          createdAt: DateTime.toDate(DateTime.makeUnsafe("2026-08-31T20:00:00.000Z")),
          content: { format: 2, parts: [{ type: "text", text: "What did we discuss?" }] },
          threadId: "thread-history",
          resourceId: "thread-history",
        },
        "input",
      );

      await processor.processInputStep({ stepNumber: 0, messageList } as never);

      const recalled = messageList.get.remembered.db();
      assert.equal(recalled.length, AKERU_RECENT_TURN_LIMIT * 2);
      assert.deepEqual(
        recalled.map((message) => message.id),
        messages.slice(-AKERU_RECENT_TURN_LIMIT * 2).map((message) => message.id),
      );
      assert.deepEqual(
        messageList.getSystemMessages("observational-memory").map((message) => message.content),
        ["Older context from observations."],
      );
      assert.equal(messageList.get.input.db()[0]?.id, "current-message");
      await reopened.close();
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("adds older observational context beside the recent message window", async () => {
    const engine = partialSdkFixture<ObservationalMemory>({
      getThreadContext: vi.fn(() => ({ threadId: "thread-context", resourceId: "thread-context" })),
      loadUnobservedMessages: vi.fn(async () => []),
      getOrCreateRecord: vi.fn(async () => ({
        activeObservations: "The user prefers short replies.",
      })),
      buildContextSystemMessages: vi.fn(async () => ["Older context: short replies."]),
    });

    const processor = new AkeruPassiveObservationalMemoryProcessor(
      engine,
      partialSdkFixture<Memory>({
        recall: vi.fn(async () => ({ messages: [] })),
        persistMessages: vi.fn(async () => undefined),
      }),
    );

    const messageList = new MessageList({
      threadId: "thread-context",
      resourceId: "thread-context",
    });

    messageList.add(
      {
        id: "recent-message",
        role: "user",
        createdAt: DateTime.toDate(DateTime.makeUnsafe("2026-08-31T20:00:00.000Z")),
        content: { format: 2, parts: [{ type: "text", text: "Use the context you remember." }] },
        threadId: "thread-context",
        resourceId: "thread-context",
      },
      "input",
    );

    await processor.processInputStep({ stepNumber: 0, messageList } as never);

    assert.deepEqual(
      messageList.getSystemMessages("observational-memory").map((message) => message.content),
      ["Older context: short replies."],
    );
    assert.lengthOf(messageList.get.input.db(), 1);
    assert.equal(messageList.get.input.db()[0]?.id, "recent-message");
  });

  it("persists only messages created by the current turn", async () => {
    const persistMessages = vi.fn(async () => undefined);

    const engine = partialSdkFixture<ObservationalMemory>({
      getThreadContext: vi.fn(() => ({ threadId: "thread-passive", resourceId: "thread-passive" })),
      loadUnobservedMessages: vi.fn(async () => []),
      getOrCreateRecord: vi.fn(async () => ({ activeObservations: "" })),
      buildContextSystemMessages: vi.fn(async () => []),
    });

    const processor = new AkeruPassiveObservationalMemoryProcessor(
      engine,
      partialSdkFixture<Memory>({
        persistMessages,
      }),
    );

    const messageList = new MessageList({
      threadId: "thread-passive",
      resourceId: "thread-passive",
    });

    messageList.add(
      {
        id: "user-history",
        role: "user",
        createdAt: DateTime.toDate(DateTime.makeUnsafe("2026-08-30T20:00:00.000Z")),
        content: { format: 2, parts: [{ type: "text", text: "Earlier turn." }] },
        threadId: "thread-passive",
        resourceId: "thread-passive",
      },
      "memory",
    );

    for (const message of [
      {
        id: "user-current",
        role: "user" as const,
        text: "Only this turn.",
        source: "input" as const,
      },
      {
        id: "assistant-current",
        role: "assistant" as const,
        text: "Current reply.",
        source: "response" as const,
      },
    ]) {
      messageList.add(
        {
          id: message.id,
          role: message.role,
          createdAt: DateTime.toDate(DateTime.makeUnsafe("2026-08-31T20:00:00.000Z")),
          content: { format: 2, parts: [{ type: "text", text: message.text }] },
          threadId: "thread-passive",
          resourceId: "thread-passive",
        },
        message.source,
      );
    }

    await processor.processOutputResult({ messageList } as never);

    expect(persistMessages).toHaveBeenCalledOnce();
    expect(persistMessages).toHaveBeenCalledWith([
      expect.objectContaining({ id: "user-current" }),
      expect.objectContaining({ id: "assistant-current" }),
    ]);
  });

  it("bounds image tool invocation args before persisting them", async () => {
    const persistMessages = vi.fn(async (_messages: ReadonlyArray<MastraDBMessage>) => undefined);

    const engine = partialSdkFixture<ObservationalMemory>({
      getThreadContext: vi.fn(() => ({ threadId: "thread-images", resourceId: "thread-images" })),
      loadUnobservedMessages: vi.fn(async () => []),
      getOrCreateRecord: vi.fn(async () => ({ activeObservations: "" })),
      buildContextSystemMessages: vi.fn(async () => []),
    });

    const processor = new AkeruPassiveObservationalMemoryProcessor(
      engine,
      partialSdkFixture<Memory>({
        persistMessages,
      }),
    );

    const messageList = new MessageList({
      threadId: "thread-images",
      resourceId: "thread-images",
    });

    messageList.add(
      {
        id: "assistant-image",
        role: "assistant" as const,
        createdAt: DateTime.toDate(DateTime.makeUnsafe("2026-08-31T20:00:00.000Z")),
        content: {
          format: 2,
          parts: [
            {
              type: "tool-invocation" as const,
              toolInvocation: {
                state: "result" as const,
                toolCallId: "image-call-1",
                toolName: "GenerateImage",
                args: {
                  operation: "edit",
                  prompt: "Private launch poster prompt",
                  inputImages: ["chat-image-1"],
                  allowProvider: "grok",
                },
                result: { status: "completed", provider: "grok" },
              },
            },
            {
              type: "tool-invocation" as const,
              toolInvocation: {
                state: "result" as const,
                toolCallId: "shell-call-1",
                toolName: "Shell",
                args: { command: "pwd" },
                result: "/home/ubuntu",
              },
            },
          ],
        },
        threadId: "thread-images",
        resourceId: "thread-images",
      },
      "response",
    );

    await processor.processOutputResult({ messageList } as never);

    expect(persistMessages).toHaveBeenCalledOnce();
    const [persisted] = persistMessages.mock.calls[0]![0];

    const imagePart = persisted?.content.parts[0];
    assert.equal(imagePart?.type, "tool-invocation");

    if (imagePart?.type === "tool-invocation") {
      assert.deepEqual(imagePart.toolInvocation.args, {
        operation: "edit",
        allowProvider: "grok",
      });
      assert.deepEqual(imagePart.toolInvocation.result, {
        status: "completed",
        provider: "grok",
      });
      assert.equal(imagePart.toolInvocation.toolCallId, "image-call-1");
    }

    const shellPart = persisted?.content.parts[1];
    assert.equal(shellPart?.type, "tool-invocation");

    if (shellPart?.type === "tool-invocation") {
      assert.deepEqual(shellPart.toolInvocation.args, { command: "pwd" });
    }

    assert.equal(JSON.stringify(persisted).includes("Private launch poster"), false);
    assert.equal(JSON.stringify(persisted).includes("chat-image-1"), false);
  });
});
