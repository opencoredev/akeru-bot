import { describe } from "vite-plus/test";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { createWorkspaceTools } from "@mastra/core/workspace";
import { PNG } from "pngjs";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { BotId, ThreadId, type AkeruToolReceipt } from "@akeru/contracts";
import { createAkeruToolRuntime } from "./AkeruToolRuntime.ts";
import { makeAkeruToolRuntimeTestSupport } from "./test-support/AkeruToolRuntime.ts";

const { directories, workspace, workspaceRoot } = makeAkeruToolRuntimeTestSupport();

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

  it("only exposes tools backed by the registered computer boundaries", () => {
    const runtime = createAkeruToolRuntime();
    runtime.registerSession("thread-1", {
      runtimeMode: "approval-required",
      workspaceType: "local",
      workspace: workspace("bot"),
    });
    expect(runtime.toolsForThread("thread-1").map((tool) => tool.id)).toEqual([
      "Shell",
      "Read",
      "AwaitShell",
    ]);
  });

  it("redacts screenshot frames before returning tool results", async () => {
    const png = new PNG({ width: 1, height: 1 });
    png.data.set([255, 255, 255, 255]);
    const bot = workspace("screenshot");
    Object.defineProperty(bot.sandbox, "computer", { value: {} });
    vi.mocked(createWorkspaceTools).mockResolvedValueOnce({
      mastra_workspace_computer_screenshot: {
        execute: async () => ({
          __workspaceMedia: true,
          text: "Screenshot captured.",
          mediaType: "image/png",
          data: PNG.sync.write(png).toString("base64"),
        }),
      },
    });
    const runtime = createAkeruToolRuntime();
    runtime.registerSession("thread-screenshot", {
      runtimeMode: "full-access",
      workspaceType: "cloud",
      workspace: bot,
    });

    const result = (await runtime.execute({
      threadId: "thread-screenshot",
      toolId: "Screenshot",
      toolCallId: "tool-screenshot",
      input: {},
      approvalMode: "require-grant",
    })) as { readonly data: string; readonly text: string };

    const frame = PNG.sync.read(Buffer.from(result.data, "base64"));

    expect(result.text).toBe("Screenshot captured.");
    expect([...frame.data]).toEqual([0, 0, 0, 255]);
  });

  it("rejects shell working directories outside both workspace boundaries", async () => {
    const runtime = createAkeruToolRuntime();
    const bot = workspace("cwd-bot");
    const user = workspace("cwd-user");
    NodeFS.mkdirSync(NodePath.join(workspaceRoot(user), "nested"));
    runtime.registerSession("thread-1", {
      runtimeMode: "full-access",
      workspaceType: "local",
      workspace: bot,
      userComputerWorkspace: user,
    });

    await expect(
      runtime.execute({
        threadId: "thread-1",
        toolId: "ExternalShell",
        toolCallId: "tool-safe-external",
        input: { command: "pwd", cwd: "nested" },
        approvalMode: "require-grant",
      }),
    ).resolves.toBeDefined();

    for (const toolId of ["Shell", "ExternalShell"] as const) {
      for (const cwd of ["/", ".."]) {
        const execution = {
          threadId: "thread-1",
          toolId,
          toolCallId: `tool-${toolId}-${cwd}`,
          input: { command: "pwd", cwd },
          approvalMode: "require-grant" as const,
        };

        if (toolId === "Shell") runtime.grantApproval(execution);
        await expect(runtime.execute(execution)).rejects.toThrow("must stay inside its workspace");
      }
    }
  });

  it("copies files only when both boundaries are registered", async () => {
    const runtime = createAkeruToolRuntime();
    const bot = workspace("copy-bot");
    const user = workspace("copy-user");
    await user.filesystem?.writeFile("report.txt", "report");
    runtime.registerSession("thread-1", {
      runtimeMode: "full-access",
      workspaceType: "local",
      workspace: bot,
      userComputerWorkspace: user,
    });

    const execution = {
      threadId: "thread-1",
      toolId: "CopyToBox" as const,
      toolCallId: "tool-copy",
      input: { sourcePath: "report.txt", destinationPath: "inbox/report.txt" },
      approvalMode: "require-grant" as const,
    };

    runtime.grantApproval(execution);
    await runtime.execute(execution);
    expect(await bot.filesystem?.readFile("inbox/report.txt", { encoding: "utf-8" })).toBe(
      "report",
    );
    NodeFS.writeFileSync(NodePath.join(workspaceRoot(user), "..", "outside.txt"), "secret");
    await expect(
      runtime.execute({
        ...execution,
        toolCallId: "tool-copy-outside",
        input: { sourcePath: "../outside.txt", destinationPath: "inbox/outside.txt" },
      }),
    ).rejects.toThrow();
  });

  it("records a human handoff request", async () => {
    const requests: unknown[] = [];

    const runtime = createAkeruToolRuntime({
      onUserActionRequired: (request) => {
        requests.push(request);
      },
    });

    runtime.registerSession("thread-1", {
      botId: BotId.make("bot-one"),
      botName: "Research bot",
      runtimeMode: "full-access",
      workspaceType: "local",
      workspace: workspace("handoff"),
    });

    await expect(
      runtime.execute({
        threadId: ThreadId.make("thread-1"),
        toolId: "request_box_help",
        toolCallId: "tool-help",
        input: { reason: "captcha", message: "Complete the CAPTCHA." },
        approvalMode: "require-grant",
      }),
    ).resolves.toEqual({ requested: true });
    expect(requests).toEqual([
      {
        botId: "bot-one",
        botName: "Research bot",
        toolId: "request_box_help",
        summary: "Complete the CAPTCHA.",
        nextAction: "Open the bot workspace and complete the requested step.",
        target: "captcha",
      },
    ]);
  });

  it("isolates user-message failures from the current thread", async () => {
    const runtime = createAkeruToolRuntime({ now: () => "2026-09-01T00:00:00.000Z" });

    const execution = {
      threadId: "thread-1",
      toolId: "SendToUser" as const,
      toolCallId: "tool-message",
      input: { message: "The export is ready." },
      approvalMode: "require-grant" as const,
    };

    runtime.registerSession("thread-1", {
      botId: BotId.make("parent"),
      runtimeMode: "full-access",
      workspaceType: "local",
      sendToUser: async () => {
        throw new Error("Message dispatch failed");
      },
    });
    runtime.grantApproval(execution);

    await expect(runtime.execute(execution)).resolves.toMatchObject({
      receiptId: "tool-message",
      toolId: "SendToUser",
      phase: "failure",
      failureCode: "internal",
      fatalToThread: false,
      summary: "Message dispatch failed",
    });
  });

  it("publishes a failure receipt when user messaging returns one", async () => {
    const receipts: AkeruToolReceipt[] = [];

    const runtime = createAkeruToolRuntime({
      now: () => "2026-09-01T00:00:00.000Z",
      onReceipt: (receipt) => receipts.push(receipt),
    });

    const execution = {
      threadId: "thread-1",
      toolId: "SendToUser" as const,
      toolCallId: "tool-message",
      input: { message: "The export is ready." },
      approvalMode: "require-grant" as const,
    };

    runtime.registerSession("thread-1", {
      botId: BotId.make("parent"),
      runtimeMode: "full-access",
      workspaceType: "local",
      sendToUser: async () => ({
        receiptId: "tool-message",
        toolId: "SendToUser",
        phase: "failure",
        threadId: ThreadId.make("thread-1"),
        botId: BotId.make("parent"),
        summary: "Message dispatch failed",
        failureCode: "internal",
        fatalToThread: false,
        createdAt: "2026-09-01T00:00:00.000Z",
      }),
    });
    runtime.grantApproval(execution);

    await expect(runtime.execute(execution)).resolves.toMatchObject({ phase: "failure" });
    expect(receipts.map((receipt) => receipt.phase)).toEqual(["start", "failure"]);
  });

  it("translates await handles to workspace process ids", async () => {
    const runtime = createAkeruToolRuntime();
    runtime.registerSession("thread-1", {
      runtimeMode: "full-access",
      workspaceType: "cloud",
      workspace: workspace("await"),
    });

    const started = await runtime.execute({
      threadId: "thread-1",
      toolId: "Shell",
      toolCallId: "tool-start",
      input: { command: "printf done", background: true },
      approvalMode: "require-grant",
    });

    const handleId = String(started).match(/PID: ([^)]+)/)?.[1];

    if (!handleId) throw new Error("Background command did not return a process id.");
    await expect(
      runtime.execute({
        threadId: "thread-1",
        toolId: "AwaitShell",
        toolCallId: "tool-await",
        input: { handleId },
        approvalMode: "require-grant",
      }),
    ).resolves.toContain("done");
  });
});
