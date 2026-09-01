// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  createWorkspaceTools,
  LocalFilesystem,
  LocalSandbox,
  Workspace,
} from "@mastra/core/workspace";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { BotId, type AkeruToolReceipt } from "@t3tools/contracts";

import { createAkeruToolRuntime } from "./AkeruToolRuntime.ts";

vi.mock("@mastra/core/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mastra/core/workspace")>();
  return { ...actual, createWorkspaceTools: vi.fn(actual.createWorkspaceTools) };
});

const directories = new Set<string>();

function workspace(name: string) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `akeru-tool-${name}-`));
  directories.add(root);
  return new Workspace({
    filesystem: new LocalFilesystem({ basePath: root }),
    sandbox: new LocalSandbox({ workingDirectory: root }),
  });
}

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

  it("exposes registered memory handlers and protects sensitive writes", async () => {
    const remember = vi.fn(async () => ({ saved: true }));
    const unavailable = vi.fn(async () => undefined);
    const runtime = createAkeruToolRuntime();
    runtime.registerSession("thread-memory", {
      runtimeMode: "full-access",
      workspaceType: "none",
      memoryHandlers: {
        recall_memory: unavailable,
        remember,
        update_memory: unavailable,
        forget_memory: unavailable,
      },
    });

    expect(runtime.toolsForThread("thread-memory").map((tool) => tool.id)).toEqual([
      "recall_memory",
      "remember",
      "update_memory",
      "forget_memory",
    ]);
    const privateWrite = {
      threadId: "thread-memory",
      toolId: "remember" as const,
      toolCallId: "private-write",
      input: { fact: "The user prefers vim.", scope: "private" },
      approvalMode: "require-grant" as const,
    };
    await expect(runtime.execute(privateWrite)).resolves.toEqual({ saved: true });

    const sensitiveWrite = {
      ...privateWrite,
      toolCallId: "sensitive-write",
      input: { fact: "  The user prefers vim.  ", scope: "private", sensitive: true },
    };
    await expect(runtime.execute(sensitiveWrite)).rejects.toThrow("requires approval");
    runtime.grantApproval(sensitiveWrite);
    await expect(runtime.execute(sensitiveWrite)).resolves.toEqual({ saved: true });
    expect(remember).toHaveBeenCalledTimes(2);
  });

  it("requires an exact one-shot grant for local shell commands", async () => {
    const receipts: AkeruToolReceipt[] = [];
    const runtime = createAkeruToolRuntime({ onReceipt: (receipt) => receipts.push(receipt) });
    runtime.registerSession("thread-1", {
      runtimeMode: "full-access",
      workspaceType: "local",
      workspace: workspace("shell"),
    });
    const execution = {
      threadId: "thread-1",
      toolId: "Shell" as const,
      toolCallId: "tool-1",
      input: { command: "pwd" },
      approvalMode: "require-grant" as const,
    };
    await expect(runtime.execute(execution)).rejects.toThrow("requires approval");
    expect(receipts.map((receipt) => receipt.phase)).toEqual(["start", "failure"]);
    expect(receipts[1]).toMatchObject({ failureCode: "denied", fatalToThread: false });
    receipts.length = 0;
    runtime.grantApproval({ ...execution, input: { command: "echo wrong" } });
    await expect(runtime.execute(execution)).rejects.toThrow("requires approval");
    receipts.length = 0;
    runtime.grantApproval({ ...execution, input: { command: " pwd " } });
    await expect(runtime.execute(execution)).resolves.toBeDefined();
    expect(receipts.map((receipt) => receipt.phase)).toEqual(["start", "success"]);
    await expect(runtime.execute(execution)).rejects.toThrow("requires approval");
  });

  it("requires approval before catalog MCP handlers run and forwards progress", async () => {
    const handler = vi.fn(async ({ emitProgress }) => {
      await emitProgress("Restarting MCP server 'search'.");
      return { servers: [{ name: "search", connected: true }] };
    });
    const onProgress = vi.fn();
    const runtime = createAkeruToolRuntime({ onProgress });
    runtime.registerSession("thread-mcp", {
      runtimeMode: "full-access",
      workspaceType: "none",
      catalogHandlers: { RestartMcpServers: handler },
    });
    const execution = {
      threadId: "thread-mcp",
      toolId: "RestartMcpServers" as const,
      toolCallId: "tool-restart",
      input: { serverIds: ["search"] },
      approvalMode: "require-grant" as const,
    };

    await expect(runtime.execute(execution)).rejects.toThrow("requires approval");
    runtime.grantApproval(execution);
    await expect(runtime.execute(execution)).resolves.toEqual({
      servers: [{ name: "search", connected: true }],
    });
    expect(onProgress).toHaveBeenCalledWith({
      threadId: "thread-mcp",
      toolId: "RestartMcpServers",
      toolCallId: "tool-restart",
      summary: "Restarting MCP server 'search'.",
    });
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
  });

  it("invalidates approvals when the thread workspace changes", async () => {
    const runtime = createAkeruToolRuntime();
    const original = workspace("original");
    const replacement = workspace("replacement");
    const user = workspace("user");
    await user.filesystem?.writeFile(".env", "SECRET=value");
    runtime.registerSession("thread-1", {
      runtimeMode: "full-access",
      workspaceType: "local",
      workspace: original,
      userComputerWorkspace: user,
    });
    const execution = {
      threadId: "thread-1",
      toolId: "CopyToBox" as const,
      toolCallId: "tool-copy",
      input: { sourcePath: ".env", destinationPath: ".env" },
      approvalMode: "require-grant" as const,
    };
    runtime.grantApproval(execution);
    runtime.registerSession("thread-1", {
      runtimeMode: "full-access",
      workspaceType: "local",
      workspace: replacement,
      userComputerWorkspace: user,
    });

    await expect(runtime.execute(execution)).rejects.toThrow("requires approval");
    await expect(replacement.filesystem?.readFile(".env")).rejects.toThrow();
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
        threadId: "thread-1",
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
  it("isolates delegation failures from the parent thread", async () => {
    const runtime = createAkeruToolRuntime();
    const execution = {
      threadId: "thread-1",
      toolId: "SendToAgent" as const,
      toolCallId: "tool-delegate",
      input: {
        botId: BotId.make("reviewer"),
        task: "Review the patch",
        expectedResult: "A verdict",
      },
      approvalMode: "require-grant" as const,
    };
    runtime.registerSession("thread-1", {
      botId: BotId.make("parent"),
      runtimeMode: "full-access",
      workspaceType: "local",
      delegation: {
        send: async () => {
          throw new Error("Provider unavailable");
        },
      },
    });
    runtime.grantApproval(execution);

    await expect(runtime.execute(execution)).resolves.toMatchObject({
      phase: "failure",
      failureCode: "internal",
      fatalToThread: false,
      billedBotId: "reviewer",
      summary: "Provider unavailable",
    });
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
