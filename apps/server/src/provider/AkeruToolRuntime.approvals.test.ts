import { describe } from "vite-plus/test";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { BotId, type AkeruToolReceipt } from "@akeru/contracts";
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

  it("exposes one direct, approval-free memory tool", async () => {
    const memory = vi.fn(async () => ({ saved: true }));
    const runtime = createAkeruToolRuntime();
    runtime.registerSession("thread-memory", {
      runtimeMode: "full-access",
      workspaceType: "none",
      memoryHandlers: {
        memory,
      },
    });

    expect(runtime.toolsForThread("thread-memory").map((tool) => tool.id)).toEqual(["memory"]);

    const write = {
      threadId: "thread-memory",
      toolId: "memory" as const,
      toolCallId: "memory-write",
      input: {
        target: "user",
        operations: [{ action: "add", content: "The user prefers vim." }],
      },
      approvalMode: "require-grant" as const,
    };

    await expect(runtime.requiresApproval("thread-memory", "memory", write.input)).resolves.toBe(
      false,
    );
    await expect(runtime.execute(write)).resolves.toEqual({ saved: true });
    expect(memory).toHaveBeenCalledOnce();
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

    runtime.grantApproval({
      ...execution,
      toolCallId: "tool-null-cwd",
      input: { command: "pwd", cwd: null, background: false },
    });
    await expect(
      runtime.execute({
        ...execution,
        toolCallId: "tool-null-cwd",
        input: { command: "pwd", background: false },
      }),
    ).resolves.toBeDefined();

    runtime.grantApproval({
      ...execution,
      toolCallId: "tool-undefined-cwd",
      input: { command: "pwd", background: false },
    });
    await expect(
      runtime.execute({
        ...execution,
        toolCallId: "tool-undefined-cwd",
        input: { command: "pwd", cwd: undefined, background: false },
      }),
    ).resolves.toBeDefined();
  });

  it("normalizes nullable optional fields consistently for approval and execution", async () => {
    const runtime = createAkeruToolRuntime();
    runtime.registerSession("nullable-shell", {
      runtimeMode: "full-access",
      workspaceType: "local",
      workspace: workspace("nullable-shell"),
    });

    const execution = {
      threadId: "nullable-shell",
      toolId: "Shell" as const,
      toolCallId: "nullable-command",
      input: { command: "pwd", cwd: null, background: null },
      approvalMode: "require-grant" as const,
    };

    await expect(
      runtime.requiresApproval(execution.threadId, execution.toolId, execution.input),
    ).resolves.toBe(true);
    runtime.grantApproval(execution);
    await expect(runtime.execute(execution)).resolves.toBeDefined();
    await expect(runtime.execute(execution)).rejects.toThrow("requires approval");
  });

  it("rejects excess properties and preserves memory input validation", async () => {
    const runtime = createAkeruToolRuntime();
    const memory = vi.fn();
    runtime.registerSession("memory-boundary", {
      runtimeMode: "full-access",
      workspaceType: "none",
      memoryHandlers: { memory },
    });

    await expect(
      runtime.execute({
        threadId: "memory-boundary",
        toolId: "memory",
        toolCallId: "invalid-memory",
        approvalMode: "require-grant",
        input: { target: null, operations: [{ action: "add", content: "Remember this." }] },
      }),
    ).rejects.toThrow();
    expect(memory).not.toHaveBeenCalled();
    expect(() =>
      runtime.grantApproval({
        threadId: "memory-boundary",
        toolId: "Shell",
        toolCallId: "extra-command",
        input: { command: "pwd", extra: null },
      }),
    ).not.toThrow();
    expect(() =>
      runtime.grantApproval({
        threadId: "memory-boundary",
        toolId: "Shell",
        toolCallId: "extra-command",
        input: { command: "pwd", extra: "unexpected" },
      }),
    ).toThrow();
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

  it("requires a production grant before an MCP connection test can reconnect", async () => {
    const testConnection = vi.fn(async () => ({ connected: true }));
    const runtime = createAkeruToolRuntime();
    runtime.registerSession("thread-mcp-test", {
      runtimeMode: "full-access",
      workspaceType: "none",
      catalogHandlers: { TestMcpServer: testConnection },
    });

    const execution = {
      threadId: "thread-mcp-test",
      toolId: "TestMcpServer" as const,
      toolCallId: "tool-test-mcp",
      input: { serverId: "search" },
      approvalMode: "require-grant" as const,
    };

    await expect(runtime.execute(execution)).rejects.toThrow("requires approval");
    expect(testConnection).not.toHaveBeenCalled();

    runtime.grantApproval(execution);
    await expect(runtime.execute(execution)).resolves.toEqual({ connected: true });
    expect(testConnection).toHaveBeenCalledOnce();
  });

  it("allows a safe read without approval and rejects path traversal", async () => {
    const runtime = createAkeruToolRuntime();
    const bot = workspace("read");
    NodeFS.writeFileSync(NodePath.join(workspaceRoot(bot), "report.txt"), "report");
    NodeFS.writeFileSync(NodePath.join(workspaceRoot(bot), "..", "outside.txt"), "secret");
    runtime.registerSession("thread-1", {
      runtimeMode: "full-access",
      workspaceType: "local",
      workspace: bot,
    });

    await expect(
      runtime.execute({
        threadId: "thread-1",
        toolId: "Read",
        toolCallId: "tool-read",
        input: { path: "report.txt" },
        approvalMode: "require-grant",
      }),
    ).resolves.toBeDefined();
    await expect(
      runtime.execute({
        threadId: "thread-1",
        toolId: "Read",
        toolCallId: "tool-read-outside",
        input: { path: "../outside.txt" },
        approvalMode: "require-grant",
      }),
    ).rejects.toThrow();
  });

  it("keeps plugin inspection read-only and requires one-shot grants for install and removal", async () => {
    const search = vi.fn(async () => ({ plugins: [] }));
    const install = vi.fn(async () => ({ installed: true }));
    const uninstall = vi.fn(async () => ({ removed: true }));
    const runtime = createAkeruToolRuntime();
    runtime.registerSession("thread-plugins", {
      runtimeMode: "full-access",
      workspaceType: "none",
      catalogHandlers: {
        SearchPlugins: search,
        InstallPlugin: install,
        UninstallPlugin: uninstall,
      },
    });

    await expect(
      runtime.execute({
        threadId: "thread-plugins",
        toolId: "SearchPlugins",
        toolCallId: "tool-search",
        input: { query: "web" },
        approvalMode: "require-grant",
      }),
    ).resolves.toEqual({ plugins: [] });

    for (const toolId of ["InstallPlugin", "UninstallPlugin"] as const) {
      const execution = {
        threadId: "thread-plugins",
        toolId,
        toolCallId: `tool-${toolId}`,
        input: { pluginId: "exa" },
        approvalMode: "require-grant" as const,
      };

      await expect(runtime.execute(execution)).rejects.toThrow("requires approval");
      runtime.grantApproval(execution);
      await expect(runtime.execute(execution)).resolves.toBeDefined();
      await expect(runtime.execute(execution)).rejects.toThrow("requires approval");
    }
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

  it("requires approval before a message reaction runs", async () => {
    const reactToMessage = vi.fn(async () => ({ status: "applied", changed: true }));
    const runtime = createAkeruToolRuntime();
    runtime.registerSession("thread-reaction", {
      botId: BotId.make("parent"),
      runtimeMode: "full-access",
      workspaceType: "none",
      reactToMessage,
    });

    const execution = {
      threadId: "thread-reaction",
      toolId: "ReactToMessage" as const,
      toolCallId: "reaction-1",
      input: { messageId: "message-1", emoji: "👍", action: "add" as const },
      approvalMode: "require-grant" as const,
    };

    await expect(runtime.execute(execution)).rejects.toThrow("requires approval");
    runtime.grantApproval(execution);
    await expect(runtime.execute(execution)).resolves.toMatchObject({ status: "applied" });
    expect(reactToMessage).toHaveBeenCalledWith(execution.input, execution.toolCallId);
  });
});
