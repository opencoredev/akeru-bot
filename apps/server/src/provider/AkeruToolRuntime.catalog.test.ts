import { decodeAkeruToolInput } from "@akeru/contracts";
import { describe } from "vite-plus/test";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { BotId, ThreadId } from "@akeru/contracts";
import { createAkeruToolRuntime } from "./AkeruToolRuntime.ts";
import { makeAkeruToolRuntimeTestSupport } from "./test-support/AkeruToolRuntime.ts";

const { directories } = makeAkeruToolRuntimeTestSupport();

vi.mock("@mastra/core/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mastra/core/workspace")>();

  return { ...actual, createWorkspaceTools: vi.fn(actual.createWorkspaceTools) };
});

describe("AkeruToolRuntime", () => {
  afterEach(() => {
    for (const directory of directories) {
      NodeFS.rmSync(directory, { force: true, recursive: true });
    }

    directories.clear();
  });

  it("exposes a narrow profile tool only for a bot-owned session", async () => {
    const updateProfile = vi.fn(async () => ({
      receiptId: "profile-1",
      toolId: "UpdateBotProfile",
      phase: "success" as const,
      threadId: ThreadId.make("thread-profile"),
      botId: BotId.make("bot-one"),
      fatalToThread: false as const,
      createdAt: "2026-09-01T02:00:00.000Z",
    }));

    const runtime = createAkeruToolRuntime();
    runtime.registerSession("thread-no-bot", {
      runtimeMode: "full-access",
      workspaceType: "none",
      botState: { updateProfile },
    });
    runtime.registerSession("thread-profile", {
      botId: BotId.make("bot-one"),
      runtimeMode: "full-access",
      workspaceType: "none",
      botState: { updateProfile },
    });

    expect(runtime.toolsForThread("thread-no-bot").map((tool) => tool.id)).not.toContain(
      "UpdateBotProfile",
    );
    expect(runtime.toolsForThread("thread-profile").map((tool) => tool.id)).toEqual([
      "UpdateBotProfile",
    ]);
    await expect(
      runtime.execute({
        threadId: "thread-profile",
        toolId: "UpdateBotProfile",
        toolCallId: "profile-1",
        input: { title: "Principal researcher" },
        approvalMode: "require-grant",
      }),
    ).resolves.toMatchObject({ phase: "success" });
    expect(updateProfile).toHaveBeenCalledWith("thread-profile", "bot-one", "profile-1", {
      title: "Principal researcher",
    });

    await expect(
      runtime.execute({
        threadId: "thread-profile",
        toolId: "UpdateBotProfile",
        toolCallId: "profile-2",
        input: { title: "Principal researcher", botId: "bot-other" },
        approvalMode: "require-grant",
      }),
    ).rejects.toThrow();
    expect(updateProfile).toHaveBeenCalledTimes(1);
  });

  it("advertises and executes a wired Mastra catalog backend", async () => {
    const fetch = vi.fn(async (_input: { readonly url: string }) => ({ text: "ok" }));
    const runtime = createAkeruToolRuntime();
    runtime.registerSession("thread-webfetch", {
      runtimeMode: "full-access",
      workspaceType: "none",
      catalogHandlers: {
        WebFetch: async ({ input }) => fetch(decodeAkeruToolInput("WebFetch", input)),
      },
    });
    expect(runtime.toolsForThread("thread-webfetch").map((tool) => tool.id)).toContain("WebFetch");
    await expect(
      runtime.execute({
        threadId: "thread-webfetch",
        toolId: "WebFetch",
        toolCallId: "tool-webfetch",
        input: { url: "https://example.com" },
        approvalMode: "require-grant",
      }),
    ).resolves.toEqual({ text: "ok" });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
