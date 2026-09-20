import { AKERU_TOOL_CATALOG } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { createPreviewToolHandlers } from "../preview/PreviewToolHandlers.ts";
import { createAkeruToolRuntime, type AkeruToolRuntime } from "./AkeruToolRuntime.ts";
import { createAkeruMastraTools } from "./AkeruMastraTools.ts";

describe("createAkeruMastraTools", () => {
  it("builds every registered Akeru tool schema", () => {
    const runtime = {
      toolsForThread: () => AKERU_TOOL_CATALOG,
      requiresApproval: vi.fn(async () => false),
      execute: vi.fn(async () => ({ ok: true })),
    } as unknown as AkeruToolRuntime;

    const tools = createAkeruMastraTools("thread-all-tools", runtime);

    expect(Object.keys(tools)).toEqual(AKERU_TOOL_CATALOG.map((definition) => definition.id));
  });

  it("passes an exact call identity and approval mode to the runtime", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const runtime = {
      toolsForThread: () => [AKERU_TOOL_CATALOG[0]!],
      requiresApproval: vi.fn(async () => true),
      execute,
    } as unknown as AkeruToolRuntime;
    const shell = createAkeruMastraTools("thread-1", runtime).Shell as {
      readonly execute?: (input: unknown, context: unknown) => Promise<unknown>;
    };
    if (!shell?.execute) throw new Error("Shell tool is unavailable.");

    await expect(
      shell.execute({ command: "pwd" }, { agent: { toolCallId: "tool-1" } } as never),
    ).resolves.toEqual({ ok: true });
    expect(execute).toHaveBeenCalledWith({
      threadId: "thread-1",
      toolId: "Shell",
      toolCallId: "tool-1",
      input: { command: "pwd" },
      approvalMode: "require-grant",
    });
    await expect(shell.execute({ command: "pwd" }, {} as never)).rejects.toThrow(
      "has no call identity",
    );
  });

  it("builds registered memory handlers as Mastra tools", async () => {
    const memoryHandler = vi.fn(async () => ({ saved: true }));
    const runtime = createAkeruToolRuntime();
    runtime.registerSession("thread-memory", {
      runtimeMode: "full-access",
      workspaceType: "none",
      memoryHandlers: {
        memory: memoryHandler,
      },
    });
    const memory = createAkeruMastraTools("thread-memory", runtime).memory as {
      readonly execute?: (input: unknown, context: unknown) => Promise<unknown>;
    };
    if (!memory?.execute) throw new Error("Memory tool is unavailable.");

    await expect(
      memory.execute(
        {
          target: "user",
          operations: [{ action: "add", content: "The user prefers vim." }],
        },
        {
          agent: { toolCallId: "memory-1" },
        } as never,
      ),
    ).resolves.toEqual({ saved: true });
    expect(memoryHandler).toHaveBeenCalledOnce();
  });

  it("builds registered preview handlers as Mastra tools", async () => {
    const invoke = vi.fn(async () => ({ available: true }));
    const runtime = createAkeruToolRuntime();
    runtime.registerSession("thread-preview", {
      runtimeMode: "full-access",
      workspaceType: "none",
      previewHandlers: createPreviewToolHandlers(invoke),
    });
    const previewStatus = createAkeruMastraTools("thread-preview", runtime).preview_status as {
      readonly execute?: (input: unknown, context: unknown) => Promise<unknown>;
    };
    if (!previewStatus?.execute) throw new Error("Preview status tool is unavailable.");

    await expect(
      previewStatus.execute(
        {},
        {
          agent: { toolCallId: "preview-1" },
        } as never,
      ),
    ).resolves.toEqual({ available: true });
    expect(invoke).toHaveBeenCalledOnce();
  });
});
