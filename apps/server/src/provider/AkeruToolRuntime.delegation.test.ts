// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  AkeruWorkerId,
  BotId,
  ThreadId,
  type AkeruToolReceipt,
  type AkeruWorkerStatus,
} from "@akeru/contracts";
import { createAkeruToolRuntime, type AkeruToolSession } from "./AkeruToolRuntime.ts";
import { AkeruWorkerError } from "./AkeruWorkerRuntime.ts";
import { makeAkeruToolRuntimeTestSupport } from "./test-support/AkeruToolRuntime.ts";

const { directories, workspace } = makeAkeruToolRuntimeTestSupport();

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

  it("limits delegated tools and requires a one-shot send grant", async () => {
    const send = vi.fn(async () => ({ delivered: true }));
    const runtime = createAkeruToolRuntime();
    runtime.registerSession("thread-delegated", {
      runtimeMode: "full-access",
      workspaceType: "local",
      workspace: workspace("delegated"),
      delegation: {
        depth: 0,
        activeDelegations: 0,
        access: {
          allowedToolIds: ["SendToAgent"],
          memoryScopes: [],
          sandbox: "local",
          runtimeMode: "full-access",
          hasUserComputer: false,
          enabledMcpServerIds: [],
          disabledMcpServerIds: [],
          approvalCeiling: "send",
        },
        send,
      },
    });
    expect(runtime.toolsForThread("thread-delegated").map((tool) => tool.id)).toEqual([
      "SendToAgent",
    ]);

    const execution = {
      threadId: "thread-delegated",
      toolId: "SendToAgent" as const,
      toolCallId: "tool-send",
      input: {
        botId: BotId.make("child-bot"),
        task: "Research the issue.",
        expectedResult: "Return the cause.",
      },
      approvalMode: "require-grant" as const,
    };

    await expect(runtime.execute(execution)).rejects.toThrow("requires approval");
    runtime.grantApproval(execution);
    await expect(runtime.execute(execution)).resolves.toEqual({ delivered: true });
    expect(send).toHaveBeenCalledOnce();
  });

  describe("temporary workers", () => {
    const WORKER_TOOLS = ["Task", "CheckSubagent", "MessageSubagent", "StopSubagent"];

    const status: AkeruWorkerStatus = {
      workerId: AkeruWorkerId.make("worker-1"),
      task: "Summarize",
      phase: {
        _tag: "Canceled",
        childThreadId: ThreadId.make("worker-thread-1"),
        startedAt: "2026-09-25T00:00:00.000Z",
        completedAt: "2026-09-25T00:01:00.000Z",
        canceledBy: "stop",
      },
    };

    const workers = (depth: number): NonNullable<AkeruToolSession["workers"]> => ({
      depth,
      spawn: vi.fn(async () => status),
      check: vi.fn(async () => status),
      message: vi.fn(async () => status),
      stop: vi.fn(async () => status),
    });

    const toolIds = (runtime: ReturnType<typeof createAkeruToolRuntime>, threadId: string) =>
      runtime.toolsForThread(threadId).map((tool) => tool.id);

    it("exposes worker tools only to sessions with a worker backend", () => {
      const runtime = createAkeruToolRuntime();
      runtime.registerSession("bot-turn", {
        runtimeMode: "approval-required",
        workspaceType: "local",
        workers: workers(0),
      });
      // Legacy-bridge sessions and worker threads register no worker backend.
      runtime.registerSession("no-workers", {
        runtimeMode: "approval-required",
        workspaceType: "local",
      });
      runtime.registerSession("depth-limit", {
        runtimeMode: "approval-required",
        workspaceType: "local",
        workers: workers(1),
      });
      expect(toolIds(runtime, "bot-turn")).toEqual(WORKER_TOOLS);
      expect(toolIds(runtime, "no-workers")).toEqual([]);
      expect(toolIds(runtime, "depth-limit")).toEqual(WORKER_TOOLS.slice(1));
    });

    it("runs worker tools without approval and reports their status", async () => {
      const backend = workers(0);
      const runtime = createAkeruToolRuntime();
      runtime.registerSession("bot-turn", {
        runtimeMode: "approval-required",
        workspaceType: "local",
        workers: backend,
      });
      await expect(
        runtime.execute({
          threadId: "bot-turn",
          toolId: "StopSubagent",
          toolCallId: "tool-stop",
          input: { workerId: "worker-1" },
          approvalMode: "require-grant",
        }),
      ).resolves.toEqual(status);
      expect(backend.stop).toHaveBeenCalledWith({ workerId: "worker-1" });
    });

    it("returns worker limit errors as failure receipts", async () => {
      const receipts: AkeruToolReceipt[] = [];

      const backend: NonNullable<AkeruToolSession["workers"]> = {
        ...workers(0),
        spawn: () =>
          Promise.reject(
            new AkeruWorkerError({
              reason: "concurrency_limit",
              detail: "This turn already has 3 running workers.",
            }),
          ),
      };

      const runtime = createAkeruToolRuntime({
        onReceipt: (receipt) => receipts.push(receipt),
        now: () => "2026-09-25T00:00:00.000Z",
      });

      runtime.registerSession("bot-turn", {
        botId: BotId.make("bot-1"),
        runtimeMode: "approval-required",
        workspaceType: "local",
        workers: backend,
      });
      await expect(
        runtime.execute({
          threadId: "bot-turn",
          toolId: "Task",
          toolCallId: "tool-task",
          input: { task: "Fourth job", background: true },
          approvalMode: "require-grant",
        }),
      ).resolves.toMatchObject({
        phase: "failure",
        toolId: "Task",
        summary: "This turn already has 3 running workers.",
      });
      expect(receipts.at(-1)).toMatchObject({
        phase: "failure",
        summary: "This turn already has 3 running workers.",
      });
    });
  });

  it("runs typed durable bot controls through the delegation backend", async () => {
    const create = vi.fn(async () => ({ botId: "bot-research" }));
    const check = vi.fn(async () => ({ state: "ready" }));
    const send = vi.fn(async () => ({ delivered: true }));
    const stop = vi.fn(async () => ({ stopped: true }));
    const runtime = createAkeruToolRuntime();
    runtime.registerSession("thread-controls", {
      runtimeMode: "full-access",
      workspaceType: "local",
      delegation: {
        depth: 0,
        activeDelegations: 0,
        access: {
          allowedToolIds: ["CreateAgent", "CheckAgent", "MessageAgent", "StopAgent"],
          memoryScopes: [],
          sandbox: "local",
          runtimeMode: "full-access",
          hasUserComputer: false,
          enabledMcpServerIds: [],
          disabledMcpServerIds: [],
          approvalCeiling: "delete",
        },
        create,
        check,
        send,
        stop,
      },
    });

    const execute = <Input>(toolId: "CreateAgent" | "CheckAgent", input: Input) =>
      runtime.execute({
        threadId: "thread-controls",
        toolId,
        toolCallId: `tool-${toolId}`,
        input,
        approvalMode: "require-grant",
      });

    await expect(execute("CreateAgent", { name: "Research" })).resolves.toEqual({
      botId: "bot-research",
    });
    await expect(execute("CheckAgent", { botId: "bot-research" })).resolves.toEqual({
      state: "ready",
    });

    for (const execution of [
      {
        threadId: "thread-controls",
        toolId: "MessageAgent" as const,
        toolCallId: "tool-message",
        input: {
          botId: BotId.make("bot-research"),
          task: "Compare flights.",
          expectedResult: "Return a short comparison.",
        },
        approvalMode: "require-grant" as const,
      },
      {
        threadId: "thread-controls",
        toolId: "StopAgent" as const,
        toolCallId: "tool-stop",
        input: { botId: BotId.make("bot-research") },
        approvalMode: "require-grant" as const,
      },
    ]) {
      await expect(runtime.execute(execution)).rejects.toThrow("requires approval");
      runtime.grantApproval(execution);
      await expect(runtime.execute(execution)).resolves.toBeDefined();
    }

    expect(send).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("returns nonfatal receipts when durable bot controls fail", async () => {
    const fail = vi.fn(async () => {
      throw new Error("Bot backend unavailable.");
    });

    const receipts: AkeruToolReceipt[] = [];
    const runtime = createAkeruToolRuntime({ onReceipt: (receipt) => receipts.push(receipt) });
    runtime.registerSession("thread-control-failures", {
      botId: BotId.make("bot-parent"),
      runtimeMode: "full-access",
      workspaceType: "local",
      delegation: {
        depth: 0,
        activeDelegations: 0,
        access: {
          allowedToolIds: ["CreateAgent", "CheckAgent", "StopAgent"],
          memoryScopes: [],
          sandbox: "local",
          runtimeMode: "full-access",
          hasUserComputer: false,
          enabledMcpServerIds: [],
          disabledMcpServerIds: [],
          approvalCeiling: "delete",
        },
        create: fail,
        check: fail,
        send: vi.fn(),
        stop: fail,
      },
    });

    for (const execution of [
      {
        threadId: "thread-control-failures",
        toolId: "CreateAgent" as const,
        toolCallId: "create-failure",
        input: { name: "Research" },
        approvalMode: "require-grant" as const,
      },
      {
        threadId: "thread-control-failures",
        toolId: "CheckAgent" as const,
        toolCallId: "check-failure",
        input: { botId: BotId.make("bot-research") },
        approvalMode: "require-grant" as const,
      },
      {
        threadId: "thread-control-failures",
        toolId: "StopAgent" as const,
        toolCallId: "stop-failure",
        input: { botId: BotId.make("bot-research") },
        approvalMode: "require-grant" as const,
      },
    ]) {
      if (execution.toolId === "StopAgent") runtime.grantApproval(execution);
      receipts.length = 0;
      await expect(runtime.execute(execution)).resolves.toMatchObject({
        receiptId: execution.toolCallId,
        toolId: execution.toolId,
        phase: "failure",
        threadId: "thread-control-failures",
        botId: "bot-parent",
        summary: "Bot backend unavailable.",
        failureCode: "internal",
        fatalToThread: false,
      });
      expect(receipts.map((receipt) => receipt.phase)).toEqual(["start", "failure"]);
    }
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
        depth: 0,
        activeDelegations: 0,
        access: {
          allowedToolIds: ["SendToAgent"],
          memoryScopes: [],
          sandbox: "local",
          runtimeMode: "full-access",
          hasUserComputer: false,
          enabledMcpServerIds: [],
          disabledMcpServerIds: [],
          approvalCeiling: "send",
        },
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
});
