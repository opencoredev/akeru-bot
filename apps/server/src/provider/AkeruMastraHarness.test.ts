// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { AuthStorage } from "@mastra/code-sdk/auth/storage";
import { RequestContext } from "@mastra/core/request-context";
import {
  AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
  AKERU_TOOL_CATALOG,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { assert, describe, it } from "vite-plus/test";

import { AKERU_AGENT_INSTRUCTIONS } from "./AkeruAgentInstructions.ts";
import {
  criticalAkeruAction,
  createAkeruMastraHarness,
  createAkeruObserveHooks,
  mastraModelId,
  resolveAkeruMastraModel,
  resolveAkeruTools,
} from "./AkeruMastraHarness.ts";
import { productFeedbackToolInputSchema } from "./AkeruMastraHarness.ts";
import type { AkeruToolRuntime } from "./AkeruToolRuntime.ts";

describe("AkeruMastraHarness", () => {
  it("initializes native observational memory", async () => {
    const stateDir = await NodeFS.promises.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "akeru-observational-memory-"),
    );
    const harness = await createAkeruMastraHarness({
      authStorage: new AuthStorage(NodePath.join(stateDir, "auth.json")),
      stateDir,
      getThreadTools: () => ({}),
      toolRuntime: { toolsForThread: () => [] } as unknown as AkeruToolRuntime,
    });
    try {
      await harness.controller.init();
    } finally {
      await harness.controller.destroy();
      await harness.destroy();
      await NodeFS.promises.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps Kimi model names on the Kimi subscription transport", () => {
    const authStorage = new AuthStorage("/tmp/akeru-unused-auth.json");
    assert.equal(
      mastraModelId(ProviderDriverKind.make("kimi"), "k3-256k"),
      "kimi-for-coding/k3-256k",
    );
    assert.deepInclude(
      resolveAkeruMastraModel("kimi-for-coding/k3-256k", authStorage, async () => ({
        accessToken: "kimi-access",
        deviceId: "0123456789abcdef0123456789abcdef",
      })),
      { provider: "anthropic.messages", modelId: "k3-256k" },
    );
    assert.throws(
      () => resolveAkeruMastraModel("kimi-for-coding/k3-256k", authStorage),
      "subscription access is unavailable",
    );
  });

  it("configures Akeru as a general-purpose assistant with plugin awareness", () => {
    assert.include(AKERU_AGENT_INSTRUCTIONS, "general-purpose assistant");
    assert.include(AKERU_AGENT_INSTRUCTIONS, "enabled plugin tools");
    assert.include(AKERU_AGENT_INSTRUCTIONS, "Do not assume");
    assert.notInclude(AKERU_AGENT_INSTRUCTIONS, "coding agent");
  });

  it("selects implemented runtime tools without dropping approval-aware plugins", async () => {
    const requestContext = new RequestContext();
    requestContext.setRaw("controller", {
      resourceId: "thread-1",
      session: { modelId: "openai/gpt-5.6-sol" },
    });
    const runtime = {
      toolsForThread: () => AKERU_TOOL_CATALOG.filter((tool) => tool.id === "Shell"),
      requiresApproval: async () => true,
      execute: async () => undefined,
    } as unknown as AkeruToolRuntime;
    const pluginTool = { id: "plugin", execute: async () => undefined, requireApproval: false };
    const approvalPolicies: boolean[] = [];

    const tools = await resolveAkeruTools(requestContext, {
      authStorage: new AuthStorage("/tmp/akeru-unused-auth.json"),
      stateDir: "/tmp",
      getThreadTools: () => ({
        exa_search: pluginTool,
        RestartMcpServers: pluginTool,
      }),
      syncThreadToolApproval: async (_threadId, _toolName, protectedAction) => {
        approvalPolicies.push(protectedAction);
      },
      toolRuntime: runtime,
    });

    assert.containsAllKeys(tools, [
      "Shell",
      "exa_search",
      "RestartMcpServers",
      AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
    ]);
    assert.notProperty(tools, "Read");
    assert.notProperty(tools, "execute_command");
    const restart = tools.RestartMcpServers as unknown as {
      readonly needsApprovalFn: (input: unknown) => Promise<boolean>;
    };
    const search = tools.exa_search as unknown as {
      readonly needsApprovalFn: (input: unknown) => Promise<boolean>;
    };
    assert.isTrue(await restart.needsApprovalFn({}));
    assert.isTrue(await search.needsApprovalFn({ operation: "send" }));
    assert.isTrue(await search.needsApprovalFn({ command: "git push origin main" }));
    assert.isTrue(await search.needsApprovalFn({ path: ".env" }));
    assert.isFalse(await search.needsApprovalFn({ operation: "read" }));
    assert.deepEqual(approvalPolicies, [true, true, true, true, false]);
    assert.equal(criticalAkeruAction("RestartMcpServers"), "production");
  });

  it("keeps product feedback draft-only and approval-gated", async () => {
    const valid = await productFeedbackToolInputSchema["~standard"].validate({
      feedback: "The button is unresponsive.",
    });
    const forbidden = await productFeedbackToolInputSchema["~standard"].validate({
      feedback: "Private payload",
      conversation: "full thread",
    });
    assert.isUndefined(valid.issues);
    assert.isDefined(forbidden.issues);

    const requestContext = new RequestContext();
    requestContext.setRaw("controller", { resourceId: "thread-1" });
    const tools = await resolveAkeruTools(requestContext, {
      authStorage: new AuthStorage("/tmp/akeru-unused-auth.json"),
      stateDir: "/tmp",
      getThreadTools: () => ({}),
      toolRuntime: { toolsForThread: () => [] } as unknown as AkeruToolRuntime,
    });
    const tool = tools[AKERU_PRODUCT_FEEDBACK_TOOL_NAME] as {
      requireApproval?: boolean;
      execute?: (input: unknown, context: unknown) => Promise<unknown>;
    };
    assert.isTrue(tool.requireApproval);
    assert.deepEqual(await tool.execute?.({ feedback: "The button is unresponsive." }, {}), {
      status: "draft-opened",
    });
  });

  it("awaits observational-memory hooks", async () => {
    const finished: unknown[] = [];
    const hooks = createAkeruObserveHooks({
      startMemoryCall: async ({ category }) => `${category}-call`,
      finishMemoryCall: async (input) => {
        finished.push(input);
      },
    });

    await hooks.onObservationStart?.({ threadId: "thread-1" });
    await hooks.onObservationEnd?.({
      threadId: "thread-1",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    await hooks.onReflectionStart?.({ threadId: "thread-1" });
    await hooks.onReflectionEnd?.({
      threadId: "thread-1",
      usage: { inputTokens: 20, outputTokens: 8 },
    });

    assert.deepEqual(finished, [
      {
        callId: "observer-call",
        category: "observer",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        callId: "reflector-call",
        category: "reflector",
        usage: { inputTokens: 20, outputTokens: 8 },
      },
    ]);

    const blocked = createAkeruObserveHooks({
      startMemoryCall: async () => {
        throw new Error("Hook rejected");
      },
    });
    let blockedError: unknown;
    try {
      await blocked.onObservationStart?.({ threadId: "thread-1" });
    } catch (error) {
      blockedError = error;
    }
    assert.instanceOf(blockedError, Error);
    assert.equal(blockedError.message, "Hook rejected");
  });
});
