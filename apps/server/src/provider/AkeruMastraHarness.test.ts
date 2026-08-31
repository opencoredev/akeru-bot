import { AuthStorage } from "@mastra/code-sdk/auth/storage";
import type { ToolsInput } from "@mastra/core/agent";
import { TOOL_NAME_OVERRIDES } from "@mastra/code-sdk/tool-names";
import { RequestContext } from "@mastra/core/request-context";
import { LocalFilesystem, LocalSandbox, Workspace } from "@mastra/core/workspace";
import { AKERU_PRODUCT_FEEDBACK_TOOL_NAME, ProviderDriverKind } from "@t3tools/contracts";
import { assert, describe, it } from "vite-plus/test";

import { AKERU_AGENT_INSTRUCTIONS } from "./AkeruAgentInstructions.ts";
import { mastraModelId, resolveAkeruMastraModel, resolveAkeruTools } from "./AkeruMastraHarness.ts";
import { productFeedbackToolInputSchema } from "./AkeruMastraHarness.ts";

describe("AkeruMastraHarness", () => {
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

  it("builds workspace and selected MCP tools from the controller resource", async () => {
    const workspace = new Workspace({
      filesystem: new LocalFilesystem({ basePath: process.cwd() }),
      sandbox: new LocalSandbox({ workingDirectory: process.cwd() }),
      tools: TOOL_NAME_OVERRIDES,
    });
    const requestContext = new RequestContext();
    requestContext.setRaw("controller", {
      resourceId: "thread-1",
      session: { modelId: "openai/gpt-5.6-sol" },
    });

    const tools = await resolveAkeruTools(requestContext, {
      authStorage: new AuthStorage("/tmp/akeru-unused-auth.json"),
      getThreadWorkspace: (threadId) => (threadId === "thread-1" ? workspace : undefined),
      getThreadTools: (threadId) =>
        (threadId === "thread-1" ? { exa_search: {} } : {}) as ToolsInput,
    });

    assert.containsAllKeys(tools, ["view", "write_file", "execute_command", "exa_search"]);
    assert.containsAllKeys(tools, [AKERU_PRODUCT_FEEDBACK_TOOL_NAME]);
    await workspace.destroy();
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
      getThreadWorkspace: () => undefined,
      getThreadTools: () => ({}),
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
});
