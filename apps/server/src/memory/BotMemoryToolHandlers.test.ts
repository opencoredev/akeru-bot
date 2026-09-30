import { BotId } from "@akeru/contracts";
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

  it("shares for an agent granted only shared scopes, but keeps its documents closed", async () => {
    const shareFact = vi.fn<AkeruMemoryShareFact>(async () => ({ status: "pending" }));
    const sharedOnly = createBotMemoryToolHandler(untouchedStore, access, new Set(), shareFact);
    const invoke = (input: Record<string, unknown>) =>
      sharedOnly.memory({ toolId: "memory", toolCallId: "call-1", input } as Parameters<
        typeof sharedOnly.memory
      >[0]);

    await expect(
      invoke({
        target: "user",
        operations: [],
        share: { fact: "Deploys happen on Fridays.", scope: "project" },
      }),
    ).resolves.toMatchObject({ share: { scope: "project", status: "pending" } });
    await expect(invoke({ target: "user", operations: [] })).rejects.toThrow(
      "outside this bot's access grant",
    );
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

  it("does not share when the document write fails", async () => {
    const shareFact = vi.fn<AkeruMemoryShareFact>(async () => ({ status: "pending" }));
    const failingStore = {
      readDocument: vi.fn(() => Promise.reject(new Error("unexpected read"))),
      mutate: vi.fn(() => Promise.reject(new Error("write failed"))),
    } as unknown as BotMemoryStore;
    await expect(
      call(
        shareFact,
        {
          target: "memory",
          operations: [{ action: "add", content: "Deploys happen on Fridays." }],
          share: { fact: "Deploys happen on Fridays.", scope: "project" },
        },
        failingStore,
      ),
    ).rejects.toThrow("write failed");
    expect(shareFact).not.toHaveBeenCalled();
  });

  it("reports a failed share beside a document write that already committed", async () => {
    const shareFact = vi.fn<AkeruMemoryShareFact>(async () => {
      throw new Error("This bot cannot share to the project.");
    });
    const document = { charCount: 10, charLimit: 2_000 };
    const committedStore = {
      readDocument: vi.fn(() => Promise.reject(new Error("unexpected read"))),
      mutate: vi.fn(async () => ({ changed: true, applied: 1, document })),
    } as unknown as BotMemoryStore;
    const result = await call(
      shareFact,
      {
        target: "memory",
        operations: [{ action: "remove", oldText: "Deploys happen on Fridays." }],
        share: { fact: "Deploys happen on Fridays.", scope: "project" },
      },
      committedStore,
    );
    expect(result).toMatchObject({
      success: true,
      changed: true,
      share: {
        scope: "project",
        status: "failed",
        message: "This bot cannot share to the project.",
      },
    });
  });
});
