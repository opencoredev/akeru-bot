import { AuthStorage } from "@mastra/code-sdk/auth/storage";
import type { ToolsInput } from "@mastra/core/agent";
import { TOOL_NAME_OVERRIDES } from "@mastra/code-sdk/tool-names";
import { RequestContext } from "@mastra/core/request-context";
import { LocalFilesystem, LocalSandbox, Workspace } from "@mastra/core/workspace";
import { assert, describe, it } from "vite-plus/test";

import { AKERU_AGENT_INSTRUCTIONS } from "./AkeruAgentInstructions.ts";
import {
  akeruActionNeedsApproval,
  criticalAkeruAction,
  resolveAkeruTools,
} from "./AkeruMastraHarness.ts";

describe("AkeruMastraHarness", () => {
  it("configures Akeru as a general-purpose assistant with plugin awareness", () => {
    assert.include(AKERU_AGENT_INSTRUCTIONS, "general-purpose assistant");
    assert.include(AKERU_AGENT_INSTRUCTIONS, "enabled plugin tools");
    assert.include(AKERU_AGENT_INSTRUCTIONS, "Do not assume");
    assert.notInclude(AKERU_AGENT_INSTRUCTIONS, "coding agent");
  });

  it("classifies every protected action without scanning inert content", () => {
    assert.equal(criticalAkeruAction("gmail_send_message"), "send");
    assert.equal(criticalAkeruAction("stripe_charge_customer"), "pay");
    assert.equal(criticalAkeruAction("storage_delete_object"), "delete");
    assert.equal(criticalAkeruAction("vercel_deploy"), "production");
    assert.equal(criticalAkeruAction("vault_get_secret"), "secrets");
    assert.equal(criticalAkeruAction("wordpress_publish_post"), "publish");
    assert.equal(criticalAkeruAction("docusign_create_signature"), "sign");
    assert.equal(criticalAkeruAction("stripe_refund_payment"), "refund");
    assert.equal(criticalAkeruAction("admin_update_account"), "account");
    assert.equal(
      criticalAkeruAction("api_request", { options: { deliveryMode: "broadcast" } }),
      "publish",
    );
    assert.isTrue(akeruActionNeedsApproval("api_request", { operation: "synchronize" }));
    assert.isFalse(akeruActionNeedsApproval("api_request", { method: "GET" }));
    assert.isFalse(
      akeruActionNeedsApproval("write_file", {
        content: "Draft copy about sending, refunds, secrets, and production.",
      }),
    );
    assert.isFalse(akeruActionNeedsApproval("write_file", { path: "notes/delete-me.txt" }));
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
    await workspace.destroy();
  });
});
