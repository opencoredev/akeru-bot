// @effect-diagnostics globalDate:off
import type { MastraDBMessage } from "@mastra/core/agent-controller";
import { describe, expect, it } from "vite-plus/test";

import { selectRecentConversation } from "./RecentConversation.ts";

const message = (id: string, role: MastraDBMessage["role"], text = id): MastraDBMessage =>
  ({
    id,
    role,
    content: { format: 2, parts: [{ type: "text", text }] },
    createdAt: new Date("2026-09-13T12:00:00.000Z"),
    threadId: "thread-1",
    resourceId: "thread-1",
  }) as MastraDBMessage;

describe("selectRecentConversation", () => {
  it("drops an incomplete older turn unless observations still require it", () => {
    const messages = [
      message("user-complete", "user", "complete question"),
      message("assistant-complete", "assistant", "complete answer"),
      message("user-interrupted", "user", "interrupted question"),
    ];

    expect(selectRecentConversation(messages).map(({ id }) => id)).toEqual([
      "user-complete",
      "assistant-complete",
    ]);
    expect(
      selectRecentConversation(messages, {
        requiredMessageIds: new Set(["user-interrupted"]),
      }).map(({ id }) => id),
    ).toEqual(["user-complete", "assistant-complete", "user-interrupted"]);
  });
  it("keeps the last thirty complete turns rather than thirty storage rows", () => {
    const history = Array.from({ length: 32 }, (_, index) => [
      message(`user-${index}`, "user"),
      message(`assistant-${index}`, "assistant"),
    ]).flat();

    expect(selectRecentConversation(history).map((entry) => entry.id)).toEqual(
      history.slice(4).map((entry) => entry.id),
    );
  });

  it("retains 64,000 estimated tokens across complete turns by default", () => {
    // Each message occupies exactly 4,000 estimated tokens, including its content envelope.
    const envelopeLength = JSON.stringify(message("size", "user", "").content).length;
    const text = "x".repeat(16_000 - envelopeLength);
    const history = Array.from({ length: 9 }, (_, index) => [
      message(`user-${index}`, "user", text),
      message(`assistant-${index}`, "assistant", text),
    ]).flat();

    expect(selectRecentConversation(history).map(({ id }) => id)).toEqual(
      history.slice(2).map(({ id }) => id),
    );
  });

  it("never splits a tool-heavy turn at the token boundary", () => {
    const history = [
      message("old-user", "user"),
      message("old-assistant", "assistant", "x".repeat(40_000)),
      message("latest-user", "user"),
      message("tool-call", "assistant", "tool call"),
      message("tool-result", "assistant", "tool result"),
      message("latest-assistant", "assistant", "done"),
    ];

    expect(selectRecentConversation(history, { tokenLimit: 20 }).map((entry) => entry.id)).toEqual([
      "latest-user",
      "tool-call",
      "tool-result",
      "latest-assistant",
    ]);
  });

  it("keeps every turn containing content newer than the latest observation", () => {
    const history = Array.from({ length: 9 }, (_, index) => [
      message(`user-${index}`, "user", "x".repeat(200)),
      message(`assistant-${index}`, "assistant", "x".repeat(200)),
    ]).flat();
    const required = new Set(["assistant-1"]);

    const selected = selectRecentConversation(history, {
      requiredMessageIds: required,
      turnLimit: 2,
      tokenLimit: 300,
    });
    expect(selected.map((entry) => entry.id)).toEqual([
      "user-1",
      "assistant-1",
      "user-7",
      "assistant-7",
      "user-8",
      "assistant-8",
    ]);
  });
});
