import { AKERU_TOOL_CATALOG } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { AkeruToolRuntime } from "./AkeruToolRuntime.ts";
import { createAkeruMastraTools } from "./AkeruMastraTools.ts";

describe("createAkeruMastraTools", () => {
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
});
