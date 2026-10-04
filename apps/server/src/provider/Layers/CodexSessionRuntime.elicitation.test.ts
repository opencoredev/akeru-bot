import * as NodeAssert from "node:assert/strict";
import { it } from "@effect/vitest";
import { describe } from "vite-plus/test";
import * as EffectCodexSchema from "effect-codex-app-server/schema";
import { toMcpElicitationResponse } from "./CodexSessionRuntime.ts";

describe("Codex MCP elicitation approvals", () => {
  it("does not approve URL elicitations without opening their requested URL", () => {
    const urlRequest = {
      mode: "url",
      message: "Finish signing in to continue.",
      serverName: "computer-use",
      threadId: "provider-thread-1",
      turnId: "turn-1",
      elicitationId: "sign-in-1",
      url: "https://example.com/authorize",
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(toMcpElicitationResponse(urlRequest, "accept"), {
      action: "decline",
    });
  });
});
