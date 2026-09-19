// @effect-diagnostics nodeBuiltinImport:off - The component contract reads its source.
import * as NodeFS from "node:fs";

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { memoryErrorMessage } from "./BotMemorySheet";
import { resolveBotThreadTarget } from "./botThreadRuntime.logic";

describe("BotMemorySheet", () => {
  it("renders direct Markdown editors, limits, and observational controls", () => {
    const source = NodeFS.readFileSync(new URL("./BotMemorySheet.tsx", import.meta.url), "utf8");
    expect(source).toContain("USER.md");
    expect(source).toContain("MEMORY.md");
    expect(source).toContain("GROUP.md");
    expect(source).toContain('data-testid="memory-documents"');
    expect(source).toContain("document.charLimit");
    expect(source).toContain("Observational memory");
    expect(source).toContain("Previous observations");
    expect(source).toContain("Clear observations");
    expect(source).toContain('role="alert"');
  });

  it("keeps server failures and falls back for unknown errors", () => {
    expect(memoryErrorMessage(new Error("Memory is too large."))).toBe("Memory is too large.");
    expect(memoryErrorMessage(null)).toBe("Memory request failed.");
  });

  it("wires the authorized bot thread into the panel", () => {
    const route = NodeFS.readFileSync(
      new URL("../../routes/_chat.bots.$botId.tsx", import.meta.url),
      "utf8",
    );
    expect(route).toContain("useBotThreadRef(botId)");
    expect(route).toContain("threadRef={threadRef}");
  });

  it("keeps memory and chat bound to the latest active bot conversation", () => {
    expect(
      resolveBotThreadTarget(
        "bot-1",
        "env-1",
        [
          {
            environmentId: "env-1",
            id: "thread-selected",
            botId: "bot-1",
            updatedAt: "2026-08-30T00:00:00.000Z",
            archivedAt: null,
            deletedAt: null,
          },
          {
            environmentId: "env-1",
            id: "thread-newer",
            botId: "bot-1",
            updatedAt: "2026-08-31T00:00:00.000Z",
            archivedAt: null,
            deletedAt: null,
          },
        ],
        "/env-1/thread-selected",
      ),
    ).toMatchObject({ threadId: ThreadId.make("thread-newer") });

    expect(EnvironmentId.make("env-1")).toBe("env-1");
    const runtime = NodeFS.readFileSync(
      new URL("./useBotThreadRuntime.ts", import.meta.url),
      "utf8",
    );
    expect(runtime).toContain("resolveBotThreadTarget(");
  });
});
