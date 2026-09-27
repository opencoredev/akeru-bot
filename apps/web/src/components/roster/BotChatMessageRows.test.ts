import { EnvironmentId, MessageId, ThreadId, type OrchestrationMessage } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { assistantRowPropsEqual } from "./BotChatMessageRows";

type RowProps = Parameters<typeof assistantRowPropsEqual>[0];

const message: OrchestrationMessage = {
  id: MessageId.make("reply-1"),
  role: "assistant",
  text: "Done.",
  turnId: null,
  streaming: false,
  createdAt: "2026-09-26T00:00:00.000Z",
  updatedAt: "2026-09-26T00:00:00.000Z",
};
const engine = { provider: "codex", model: "gpt" } as const;
const result = { kind: "plugin-search-results" } as unknown as NonNullable<
  RowProps["pluginResults"]
>[number]["result"];

function props(overrides: Partial<RowProps> = {}): RowProps {
  return {
    message,
    author: { name: "Akeru", avatar: { kind: "dither", seed: "a" } },
    testId: "row",
    cwd: "/work",
    threadRef: { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") },
    stepMeter: { engine, tokens: 10, costUsd: null, hardStopReached: false },
    pluginResults: [{ id: "entry-1", result }],
    currentPersonId: "person",
    playback: null,
    playbackKey: "env/thread",
    channelApproval: null,
    onReply: vi.fn(),
    onReactionChange: vi.fn(),
    ...overrides,
  } as RowProps;
}

describe("assistant row memoization", () => {
  it("skips re-rendering when per-turn data is rebuilt with the same content", () => {
    const previous = props();
    const next = {
      ...previous,
      stepMeter: { ...previous.stepMeter!, engine: { ...engine } },
      pluginResults: previous.pluginResults!.map((entry) => ({ ...entry })),
    };
    expect(assistantRowPropsEqual(previous, next)).toBe(true);
  });

  it("re-renders when the message, meter, playback context, or handlers change", () => {
    const previous = props();
    expect(assistantRowPropsEqual(previous, { ...previous, message: { ...message } })).toBe(false);
    expect(
      assistantRowPropsEqual(previous, {
        ...previous,
        stepMeter: { ...previous.stepMeter!, tokens: 11 },
      }),
    ).toBe(false);
    expect(assistantRowPropsEqual(previous, { ...previous, playbackKey: null })).toBe(false);
    expect(assistantRowPropsEqual(previous, { ...previous, onReply: vi.fn() })).toBe(false);
  });
});
