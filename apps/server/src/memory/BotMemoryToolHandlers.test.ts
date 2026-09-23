import { BotId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { BotMemoryStore } from "./BotMemory.ts";
import {
  AKERU_MEMORY_TOOL_DESCRIPTION,
  createBotMemoryToolHandler,
  type AkeruMemoryShareFact,
} from "./BotMemoryToolHandlers.ts";

const access = { botId: BotId.make("bot-ada"), groupId: null, groupMemberBotIds: [] };

// Share-only calls never touch the Markdown documents.
const untouchedStore = {
  readDocument: vi.fn(() => Promise.reject(new Error("unexpected read"))),
  applyOperations: vi.fn(() => Promise.reject(new Error("unexpected write"))),
} as unknown as BotMemoryStore;

const call = (
  shareFact: AkeruMemoryShareFact | undefined,
  input: Record<string, unknown>,
  store: BotMemoryStore = untouchedStore,
) =>
  createBotMemoryToolHandler(store, access, new Set(["user", "memory"]), shareFact).memory({
    toolId: "memory",
    toolCallId: "call-1",
    input,
  } as Parameters<ReturnType<typeof createBotMemoryToolHandler>["memory"]>[0]);

describe("memory tool shared facts", () => {
  it("describes when to share and how to treat a pending approval", () => {
    expect(AKERU_MEMORY_TOOL_DESCRIPTION).toContain("pass share with the exact fact text");
    expect(AKERU_MEMORY_TOOL_DESCRIPTION).toContain("Set sensitive to true");
    expect(AKERU_MEMORY_TOOL_DESCRIPTION).toContain("do not call share again for the same fact");
  });

  it("reports a pending share without reading or writing documents", async () => {
    const shareFact = vi.fn<AkeruMemoryShareFact>(async () => ({ status: "pending" }));
    const result = await call(shareFact, {
      target: "user",
      operations: [],
      share: { fact: "Deploys happen on Fridays.", scope: "project" },
    });
    expect(shareFact).toHaveBeenCalledWith({
      fact: "Deploys happen on Fridays.",
      scope: "project",
      sensitive: false,
    });
    expect(result).toMatchObject({
      success: true,
      done: true,
      share: { scope: "project", status: "pending" },
    });
  });

  it("passes sensitivity through and reports a saved share", async () => {
    const shareFact = vi.fn<AkeruMemoryShareFact>(async () => ({ status: "saved" }));
    const result = await call(shareFact, {
      target: "user",
      operations: [],
      share: { fact: "The team uses pnpm.", scope: "workspace", sensitive: true },
    });
    expect(shareFact).toHaveBeenCalledWith({
      fact: "The team uses pnpm.",
      scope: "workspace",
      sensitive: true,
    });
    expect(result).toMatchObject({ share: { status: "saved" } });
  });

  it("rejects shares when shared memory is unavailable or the fact is unsafe", async () => {
    await expect(
      call(undefined, {
        target: "user",
        operations: [],
        share: { fact: "Deploys happen on Fridays.", scope: "project" },
      }),
    ).rejects.toThrow("Shared memory is not available in this chat.");

    const shareFact = vi.fn<AkeruMemoryShareFact>(async () => ({ status: "pending" }));
    await expect(
      call(shareFact, {
        target: "user",
        operations: [],
        share: { fact: "Hidden​note", scope: "project" },
      }),
    ).rejects.toThrow("Memory content was rejected");
    expect(shareFact).not.toHaveBeenCalled();
  });
});
