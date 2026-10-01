import { ProviderDriverKind } from "@akeru/contracts";
import { CommandId, DEFAULT_PROVIDER_INTERACTION_MODE, ThreadId } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { it as effectIt } from "@effect/vitest";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  asTurnId,
  asEventId,
  asThreadId,
  asItemId,
  waitForThread,
  type ProviderRuntimeTestMessage,
  asMessageId,
  createRuntimeIngestionHarness,
} from "./test-support/RuntimeIngestionHarness.ts";

describe("ProviderRuntimeIngestion", () => {
  const testScope = createRuntimeIngestionHarness();
  const { createHarness } = testScope;
  afterEach(testScope.dispose);
  it("adds a visible reply when a completed turn emitted only whitespace", async () => {
    const harness = await createHarness();
    const turnId = asTurnId("turn-whitespace-only");

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-whitespace-started"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:01.000Z",
      turnId,
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-turn-whitespace-delta"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:02.000Z",
      turnId,
      itemId: asItemId("item-whitespace-only"),
      payload: { streamKind: "assistant_text", delta: "   \n" },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-whitespace-completed"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:03.000Z",
      turnId,
      payload: { state: "completed" },
    });

    const thread = await waitForThread(harness, (entry) =>
      entry.messages.some(
        (message) =>
          message.turnId === turnId &&
          message.text === "I finished without a text response. Please try again.",
      ),
    );
    expect(thread.messages.filter((message) => message.turnId === turnId)).toHaveLength(1);
  });

  it("adds an actionable reply when a failed turn has no assistant text", async () => {
    const harness = await createHarness();
    const turnId = asTurnId("turn-failed-without-text");

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-failed-without-text-started"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:01.000Z",
      turnId,
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-failed-without-text-completed"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:02.000Z",
      turnId,
      payload: { state: "failed", errorMessage: "Provider crashed" },
    });

    const thread = await waitForThread(harness, (entry) =>
      entry.messages.some(
        (message) =>
          message.turnId === turnId &&
          message.text === "I cannot complete the request. Check the error details.",
      ),
    );
    expect(thread.messages.filter((message) => message.turnId === turnId)).toHaveLength(1);
  });

  it("maps canonical content delta/item completed into finalized assistant messages", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-1"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        streamKind: "assistant_text",
        delta: "hello",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-2"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        streamKind: "assistant_text",
        delta: " world",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-1" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-1",
    );
    expect(message?.text).toBe("hello world");
    expect(message?.streaming).toBe(false);
  });

  it("ignores provider content deltas that cannot change thread state", async () => {
    const harness = await createHarness();
    const before = await harness.readModel();

    for (const [index, streamKind] of (
      ["command_output", "file_change_output", "reasoning_summary_text", "reasoning_text"] as const
    ).entries()) {
      harness.emit({
        type: "content.delta",
        eventId: asEventId(`evt-ignored-delta-${index}`),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:01.000Z",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-ignored-deltas"),
        itemId: asItemId(`item-ignored-delta-${index}`),
        payload: { streamKind, delta: "large transient provider output" },
      });
    }

    await harness.drain();

    expect(await harness.readModel()).toEqual(before);
  });

  it("projects a persisted tool screenshot as an assistant image attachment", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-preview-screenshot"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-preview"),
      itemId: asItemId("tool-preview-snapshot"),
      payload: {
        itemType: "mcp_tool_call",
        status: "completed",
        title: "preview_snapshot",
        data: {
          result: { url: "https://example.com" },
          chatAttachment: {
            type: "image",
            id: "thread-1-00000000-0000-4000-8000-000000000001",
            name: "browser-screenshot.png",
            mimeType: "image/png",
            sizeBytes: 42,
          },
        },
      },
    });

    const thread = await waitForThread(harness, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "provider-attachment-evt-preview-screenshot" && !message.streaming,
      ),
    );
    expect(
      thread.messages.find(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "provider-attachment-evt-preview-screenshot",
      ),
    ).toMatchObject({
      role: "assistant",
      text: "",
      attachments: [
        {
          type: "image",
          id: "thread-1-00000000-0000-4000-8000-000000000001",
          name: "browser-screenshot.png",
          mimeType: "image/png",
          sizeBytes: 42,
        },
      ],
    });
  });

  it("persists separate assistant notes while one turn remains active", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const threadId = asThreadId("thread-1");
    const turnId = asTurnId("turn-status-beats");

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-status-turn-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId,
      turnId,
    });
    for (const [itemId, text] of [
      ["reply-before-tools", "I'll check that now."],
      ["status-after-tool", "I found the relevant setting."],
    ] as const) {
      harness.emit({
        type: "content.delta",
        eventId: asEventId(`evt-${itemId}-delta`),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId,
        turnId,
        itemId: asItemId(itemId),
        payload: { streamKind: "assistant_text", delta: text },
      });
      harness.emit({
        type: "item.completed",
        eventId: asEventId(`evt-${itemId}-completed`),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId,
        turnId,
        itemId: asItemId(itemId),
        payload: { itemType: "assistant_message", status: "completed" },
      });
    }

    const thread = await waitForThread(harness, (entry) =>
      ["assistant:reply-before-tools", "assistant:status-after-tool"].every((id) =>
        entry.messages.some(
          (message: ProviderRuntimeTestMessage) => message.id === id && !message.streaming,
        ),
      ),
    );
    expect(
      thread.messages
        .filter((message: ProviderRuntimeTestMessage) => message.turnId === turnId)
        .map((message: ProviderRuntimeTestMessage) => message.text),
    ).toEqual(["I'll check that now.", "I found the relevant setting."]);
    expect(thread.session?.activeTurnId).toBe(turnId);
  });

  it("uses assistant item completion detail when no assistant deltas were streamed", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-assistant-item-completed-no-delta"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-no-delta"),
      itemId: asItemId("item-no-delta"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "assistant-only final text",
      },
    });

    const thread = await waitForThread(harness, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-no-delta" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-no-delta",
    );
    expect(message?.text).toBe("assistant-only final text");
    expect(message?.streaming).toBe(false);
  });

  it("streams assistant deltas when thread.turn.start requests streaming mode", async () => {
    const harness = await createHarness({ serverSettings: { enableLegacyTokenStreaming: true } });
    const now = "2026-01-01T00:00:00.000Z";

    await harness.run(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-streaming-mode"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("message-streaming-mode"),
          role: "user",
          text: "stream please",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-streaming-mode"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-mode"),
    });
    await waitForThread(
      harness,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-streaming-mode",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-mode"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-mode"),
      itemId: asItemId("item-streaming-mode"),
      payload: {
        streamKind: "assistant_text",
        delta: "hello live",
      },
    });

    const liveThread = await waitForThread(harness, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-mode" &&
          message.streaming &&
          message.text === "hello live",
      ),
    );
    const liveMessage = liveThread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-streaming-mode",
    );
    expect(liveMessage?.streaming).toBe(true);

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-streaming-mode"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-mode"),
      itemId: asItemId("item-streaming-mode"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "hello live",
      },
    });

    const finalThread = await waitForThread(harness, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-mode" && !message.streaming,
      ),
    );
    const finalMessage = finalThread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-streaming-mode",
    );
    expect(finalMessage?.text).toBe("hello live");
    expect(finalMessage?.streaming).toBe(false);
  });

  it("spills oversized buffered deltas and still finalizes full assistant text", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const oversizedText = "x".repeat(40_000);

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffer-spill"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffer-spill"),
    });
    await waitForThread(
      harness,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffer-spill",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffer-spill"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffer-spill"),
      itemId: asItemId("item-buffer-spill"),
      payload: {
        streamKind: "assistant_text",
        delta: oversizedText,
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-buffer-spill"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffer-spill"),
      itemId: asItemId("item-buffer-spill"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffer-spill" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-buffer-spill",
    );
    expect(message?.text.length).toBe(oversizedText.length);
    expect(message?.text).toBe(oversizedText);
    expect(message?.streaming).toBe(false);
  });

  effectIt.effect(
    "does not duplicate assistant completion when item.completed is followed by turn.completed",
    () =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() => createHarness());
        const now = "2026-01-01T00:00:00.000Z";

        harness.emit({
          type: "turn.started",
          eventId: asEventId("evt-turn-started-for-complete-dedup"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: now,
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-complete-dedup"),
        });

        yield* Effect.promise(() =>
          waitForThread(
            harness,
            (thread) =>
              thread.session?.status === "running" &&
              thread.session?.activeTurnId === "turn-complete-dedup",
          ),
        );

        harness.emit({
          type: "content.delta",
          eventId: asEventId("evt-message-delta-for-complete-dedup"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: now,
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-complete-dedup"),
          itemId: asItemId("item-complete-dedup"),
          payload: {
            streamKind: "assistant_text",
            delta: "done",
          },
        });
        harness.emit({
          type: "item.completed",
          eventId: asEventId("evt-message-completed-for-complete-dedup"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: now,
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-complete-dedup"),
          itemId: asItemId("item-complete-dedup"),
          payload: {
            itemType: "assistant_message",
            status: "completed",
          },
        });
        harness.emit({
          type: "turn.completed",
          eventId: asEventId("evt-turn-completed-for-complete-dedup"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: now,
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-complete-dedup"),
          payload: {
            state: "completed",
          },
        });

        yield* Effect.promise(() =>
          waitForThread(
            harness,
            (thread) =>
              thread.session?.status === "ready" &&
              thread.session?.activeTurnId === null &&
              thread.messages.some(
                (message: ProviderRuntimeTestMessage) =>
                  message.id === "assistant:item-complete-dedup" && !message.streaming,
              ),
          ),
        );

        const events = yield* Stream.runCollect(harness.engine.readEvents(0));
        const completionEvents = events.filter((event) => {
          if (event.type !== "thread.message-sent") {
            return false;
          }
          return (
            event.payload.messageId === "assistant:item-complete-dedup" &&
            event.payload.streaming === false
          );
        });
        expect(completionEvents).toHaveLength(1);
      }),
  );
});
