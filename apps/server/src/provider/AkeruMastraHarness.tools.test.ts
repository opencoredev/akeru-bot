import { probeTool, harnessAgent } from "./test-support/toolProbe.ts";
import { toolRuntimeFixture } from "./test-support/toolRuntimeFixture.ts";
import { describe } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { AuthStorage } from "@mastra/code-sdk/auth/storage";
import { RequestContext } from "@mastra/core/request-context";
import {
  AKERU_CREATE_ROUTINE_TOOL_NAME,
  AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
  AKERU_TOOL_CATALOG,
} from "@akeru/contracts";
import { it } from "@effect/vitest";
import { assert } from "vite-plus/test";
import {
  AKERU_DELETE_ROUTINES_TOOL_NAME,
  AKERU_LIST_ROUTINES_TOOL_NAME,
  criticalAkeruAction,
  resolveAkeruTools,
  routineToolInputSchema,
  routineToolNeedsGlobalApproval,
} from "./AkeruMastraHarness.ts";
import { productFeedbackToolInputSchema } from "./AkeruMastraHarness.ts";
import { makeAkeruMastraHarnessTestSupport } from "./test-support/AkeruMastraHarness.ts";

const { harnessTest } = makeAkeruMastraHarnessTestSupport();

describe("AkeruMastraHarness", () => {
  it.effect(
    "does not give the agent task-list tools, which cost a model round trip per update",
    () =>
      harnessTest(async (open) => {
        const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-no-tasks-"));

        const harness = await open({
          authStorage: new AuthStorage(NodePath.join(directory, "auth.json")),
          memoryDbPath: NodePath.join(directory, "observational-memory.sqlite"),
          getThreadTools: () => ({}),
          toolRuntime: toolRuntimeFixture({ toolsForThread: () => [] }),
        });

        try {
          // The controller keeps its agent private; the tool list is what the model sees.
          const agent = harnessAgent(harness);
          const requestContext = new RequestContext();
          requestContext.setRaw("controller", { resourceId: "thread-tools" });
          const toolIds = Object.keys(await agent.listTools({ requestContext }));
          assert.isNotEmpty(toolIds);

          for (const id of ["task_write", "task_update", "task_complete", "task_check"]) {
            assert.notInclude(toolIds, id);
          }
        } finally {
          await harness.close();
          NodeFS.rmSync(directory, { recursive: true, force: true });
        }
      }),
  );

  it("selects implemented runtime tools without dropping approval-aware plugins", async () => {
    const requestContext = new RequestContext();
    requestContext.setRaw("controller", {
      resourceId: "thread-1",
      session: { modelId: "openai/gpt-5.6-sol" },
    });
    const approvalInputs: unknown[] = [];

    const runtime = toolRuntimeFixture({
      toolsForThread: () => AKERU_TOOL_CATALOG.filter((tool) => tool.id === "Shell"),
      requiresApproval: async (_threadId, _toolId, input) => {
        approvalInputs.push(input);

        return true;
      },
      execute: async () => undefined,
    });

    const pluginTool = { id: "plugin", execute: async () => undefined, requireApproval: false };
    const approvalPolicies: boolean[] = [];

    const tools = await resolveAkeruTools(requestContext, {
      authStorage: new AuthStorage("/tmp/akeru-unused-auth.json"),
      getThreadTools: () => ({
        exa_search: pluginTool,
        RestartMcpServers: pluginTool,
        Shell: pluginTool,
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

    const shell = probeTool(tools.Shell);

    const restart = probeTool(tools.RestartMcpServers);

    const search = probeTool(tools.exa_search);

    assert.isTrue(await restart.needsApprovalFn({}));
    assert.isTrue(await search.needsApprovalFn({ operation: "send" }));
    assert.isTrue(await search.needsApprovalFn({ command: "git push origin main" }));
    assert.isTrue(await search.needsApprovalFn({ path: ".env" }));
    assert.isFalse(await search.needsApprovalFn({ operation: "read" }));
    assert.isTrue(
      await shell.needsApprovalFn({ command: 'printf "hi\\n"', cwd: null, background: null }),
    );
    assert.deepEqual(approvalInputs, [{ command: 'printf "hi\\n"' }]);
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
      getThreadTools: () => ({}),
      toolRuntime: toolRuntimeFixture({ toolsForThread: () => [] }),
    });

    const tool = probeTool(tools[AKERU_PRODUCT_FEEDBACK_TOOL_NAME]);

    assert.isTrue(tool.requireApproval);
    assert.deepEqual(await tool.execute?.({ feedback: "The button is unresponsive." }, {}), {
      status: "draft-opened",
    });
  });

  it("creates an approved routine for the current chat after tool approval", async () => {
    assert.isFalse(routineToolNeedsGlobalApproval(AKERU_CREATE_ROUTINE_TOOL_NAME));
    assert.isFalse(routineToolNeedsGlobalApproval(AKERU_LIST_ROUTINES_TOOL_NAME));
    assert.isTrue(routineToolNeedsGlobalApproval("execute_command"));
    assert.isTrue(
      routineToolInputSchema.safeParse({
        name: "Morning brief",
        instructions: "Prepare the morning brief.",
        schedule: { kind: "weekdays", time: "09:00" },
      }).success,
    );
    assert.isTrue(
      routineToolInputSchema.safeParse({
        name: "Morning brief",
        instructions: "Prepare the morning brief.",
        schedule: { kind: "weekdays", time: "09:00" },
        connectorNames: null,
      }).success,
    );
    assert.isFalse(
      routineToolInputSchema.safeParse({
        name: "Morning brief",
        instructions: "Prepare the morning brief.",
        schedule: { kind: "weekdays", time: {} },
      }).success,
    );
    const calls: unknown[] = [];
    const requestContext = new RequestContext();
    requestContext.setRaw("controller", { resourceId: "thread-1" });

    const tools = await resolveAkeruTools(requestContext, {
      authStorage: new AuthStorage("/tmp/akeru-unused-auth.json"),
      getThreadTools: () => ({}),
      toolRuntime: toolRuntimeFixture({ toolsForThread: () => [] }),
      createRoutine: async (threadId, input) => {
        calls.push({ threadId, input });

        return { status: "approved" };
      },
    });

    const tool = probeTool(tools[AKERU_CREATE_ROUTINE_TOOL_NAME]);

    assert.isFalse(tool.requireApproval);
    assert.deepEqual(calls, []);
    assert.deepEqual(
      await tool.execute?.(
        {
          name: "Morning brief",
          instructions: "Prepare the morning brief.",
          schedule: { kind: "weekdays", time: "09:00" },
          skillNames: null,
          connectorNames: null,
        },
        {},
      ),
      { status: "approved" },
    );
    assert.deepEqual(calls, [
      {
        threadId: "thread-1",
        input: {
          name: "Morning brief",
          instructions: "Prepare the morning brief.",
          schedule: { kind: "weekdays", time: "09:00" },
        },
      },
    ]);
  });

  it("lets the model inspect this bot's routine states without approval", async () => {
    const calls: string[] = [];
    const requestContext = new RequestContext();
    requestContext.setRaw("controller", { resourceId: "thread-1" });

    const result = {
      routines: [
        { id: "routine-1", name: "Morning brief", enabled: true, lifecycle: "enabled" as const },
        {
          id: "routine-2",
          name: "Weekly review",
          enabled: false,
          lifecycle: "approved" as const,
        },
        {
          id: "routine-3",
          name: "Inbox check",
          enabled: false,
          lifecycle: "paused" as const,
        },
      ],
    };

    const tools = await resolveAkeruTools(requestContext, {
      authStorage: new AuthStorage("/tmp/akeru-unused-auth.json"),
      getThreadTools: () => ({}),
      toolRuntime: toolRuntimeFixture({ toolsForThread: () => [] }),
      listRoutines: async (threadId) => {
        calls.push(threadId);

        return result;
      },
    });

    const tool = probeTool(tools[AKERU_LIST_ROUTINES_TOOL_NAME]);

    assert.deepEqual(calls, []);
    assert.isFalse(tool.requireApproval);
    assert.deepEqual(await tool.execute?.({}, {}), result);
    assert.deepEqual(calls, ["thread-1"]);
  });

  it("asks once before deleting one or more routines", async () => {
    const deleted: Array<{ threadId: string; routineIds: ReadonlyArray<string> }> = [];
    const suspended: unknown[] = [];
    const requestContext = new RequestContext();
    requestContext.setRaw("controller", { resourceId: "thread-1" });

    const tools = await resolveAkeruTools(requestContext, {
      authStorage: new AuthStorage("/tmp/akeru-unused-auth.json"),
      getThreadTools: () => ({}),
      toolRuntime: toolRuntimeFixture({ toolsForThread: () => [] }),
      listRoutines: async () => ({
        routines: [
          { id: "routine-1", name: "Morning brief", enabled: true, lifecycle: "enabled" },
          { id: "routine-2", name: "Weekly review", enabled: false, lifecycle: "paused" },
        ],
      }),
      deleteRoutines: async (threadId, routineIds) => {
        deleted.push({ threadId, routineIds });

        return { status: "deleted", deletedRoutineIds: [...routineIds] };
      },
    });

    const tool = probeTool(tools[AKERU_DELETE_ROUTINES_TOOL_NAME]);

    const input = { routineIds: ["routine-1", "routine-2"] };

    assert.isFalse(tool.requireApproval);
    assert.deepEqual(deleted, []);
    await tool.execute?.(input, {
      agent: { suspend: async (payload) => void suspended.push(payload) },
    });
    assert.deepEqual(deleted, []);
    assert.deepEqual(suspended, [
      {
        question:
          'Are you sure you want to delete these routines: "Morning brief", "Weekly review"?',
        options: [
          {
            label: "Delete routines",
            description: "Stop these schedules and hide them from the routines list.",
          },
          { label: "Cancel", description: "Keep every routine." },
        ],
        selectionMode: "single_select",
      },
    ]);

    assert.deepEqual(await tool.execute?.(input, { agent: { resumeData: "Cancel" } }), {
      status: "cancelled",
      deletedRoutineIds: [],
    });
    assert.deepEqual(deleted, []);
    assert.deepEqual(await tool.execute?.(input, { agent: { resumeData: "Delete routines" } }), {
      status: "deleted",
      deletedRoutineIds: ["routine-1", "routine-2"],
    });
    assert.deepEqual(deleted, [{ threadId: "thread-1", routineIds: ["routine-1", "routine-2"] }]);
  });

  it("does not ask or delete when any requested routine is unavailable", async () => {
    let suspended = false;
    let deleted = false;
    const requestContext = new RequestContext();
    requestContext.setRaw("controller", { resourceId: "thread-1" });

    const tools = await resolveAkeruTools(requestContext, {
      authStorage: new AuthStorage("/tmp/akeru-unused-auth.json"),
      getThreadTools: () => ({}),
      toolRuntime: toolRuntimeFixture({ toolsForThread: () => [] }),
      listRoutines: async () => ({ routines: [] }),
      deleteRoutines: async () => {
        deleted = true;

        return { status: "deleted", deletedRoutineIds: [] };
      },
    });

    const tool = probeTool(tools[AKERU_DELETE_ROUTINES_TOOL_NAME]);

    assert.deepEqual(
      await tool.execute?.(
        { routineIds: ["missing-routine"] },
        { agent: { suspend: async () => void (suspended = true) } },
      ),
      { status: "not-found", deletedRoutineIds: [] },
    );
    assert.isFalse(suspended);
    assert.isFalse(deleted);
  });
});
