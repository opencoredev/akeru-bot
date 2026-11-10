import { AuthStorage } from "@mastra/code-sdk/auth/storage";
import { RequestContext } from "@mastra/core/request-context";
import {
  AKERU_CREATE_ROUTINE_TOOL_NAME,
  BotPermissionPersonId,
  DEFAULT_BOT_PERMISSION_POLICY,
  type BotPermissionPolicy,
} from "@akeru/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  AKERU_DELETE_ROUTINES_TOOL_NAME,
  AKERU_LIST_ROUTINES_TOOL_NAME,
  resolveAkeruTools,
} from "./AkeruMastraHarness.ts";
import { probeTool } from "./test-support/toolProbe.ts";
import { toolRuntimeFixture } from "./test-support/toolRuntimeFixture.ts";

const routines = {
  routines: [
    { id: "routine-1", name: "Morning brief", enabled: true, lifecycle: "enabled" as const },
  ],
};

const routineInput = {
  name: "Morning brief",
  instructions: "Prepare the morning brief.",
  schedule: { kind: "weekdays", time: "09:00" },
  skillNames: null,
  connectorNames: null,
};

async function setup(initial: BotPermissionPolicy) {
  let policy = initial;
  const created: unknown[] = [];
  const deleted: unknown[] = [];
  let listed = 0;
  const runtime = toolRuntimeFixture({ toolsForThread: () => [] });

  runtime.registerSession("thread-1", {
    runtimeMode: "full-access",
    workspaceType: "none",
    permissions: { principal: { kind: "owner" }, policy, readPolicy: async () => policy },
  });

  const requestContext = new RequestContext();
  requestContext.setRaw("controller", { resourceId: "thread-1" });

  const tools = await resolveAkeruTools(requestContext, {
    authStorage: new AuthStorage("/tmp/akeru-unused-auth.json"),
    getThreadTools: () => ({}),
    toolRuntime: runtime,
    listRoutines: async () => {
      listed += 1;

      return routines;
    },
    deleteRoutines: async (_threadId, routineIds) => {
      deleted.push(routineIds);

      return { status: "deleted", deletedRoutineIds: [...routineIds] };
    },
    createRoutine: async (_threadId, input) => {
      created.push(input);

      return { status: "approved" };
    },
  });

  return {
    runtime,
    created,
    deleted,
    listedCount: () => listed,
    list: probeTool(tools[AKERU_LIST_ROUTINES_TOOL_NAME]),
    create: probeTool(tools[AKERU_CREATE_ROUTINE_TOOL_NAME]),
    remove: probeTool(tools[AKERU_DELETE_ROUTINES_TOOL_NAME]),
    setPolicy: (next: BotPermissionPolicy) => {
      policy = next;
    },
  };
}

const deny = (toolName: string): BotPermissionPolicy => ({
  ...DEFAULT_BOT_PERMISSION_POLICY,
  toolOverrides: { [toolName]: "deny" },
});

describe("routine tools under the bot permission policy", () => {
  it("refuses to create a routine the policy denies", async () => {
    const { create, created } = await setup(deny(AKERU_CREATE_ROUTINE_TOOL_NAME));

    await expect(create.execute?.(routineInput, {})).rejects.toThrow(
      "not allowed by this bot's permission policy",
    );
    expect(created).toEqual([]);
  });

  it("refuses to delete routines when outside writes are denied", async () => {
    const { remove, deleted } = await setup({
      ...DEFAULT_BOT_PERMISSION_POLICY,
      defaults: { ...DEFAULT_BOT_PERMISSION_POLICY.defaults, "write-outside": "deny" },
    });

    const suspended: unknown[] = [];

    await expect(
      remove.execute?.(
        { routineIds: ["routine-1"] },
        { agent: { suspend: async (payload) => void suspended.push(payload) } },
      ),
    ).rejects.toThrow("not allowed");
    expect(suspended).toEqual([]);
    expect(deleted).toEqual([]);
  });

  it("re-checks the policy after the owner confirms a deletion", async () => {
    const { remove, deleted, setPolicy } = await setup(DEFAULT_BOT_PERMISSION_POLICY);
    const input = { routineIds: ["routine-1"] };

    await remove.execute?.(input, { agent: { suspend: async () => undefined } });
    setPolicy(deny(AKERU_DELETE_ROUTINES_TOOL_NAME));

    await expect(
      remove.execute?.(input, { agent: { resumeData: "Delete routines" } }),
    ).rejects.toThrow("not allowed");
    expect(deleted).toEqual([]);
  });

  const listCall = {
    threadId: "thread-1",
    toolCallId: "list-1",
    toolName: AKERU_LIST_ROUTINES_TOOL_NAME,
    input: {},
  };

  it.each([
    [
      "defaults.read: deny",
      {
        ...DEFAULT_BOT_PERMISSION_POLICY,
        defaults: { ...DEFAULT_BOT_PERMISSION_POLICY.defaults, read: "deny" as const },
      },
    ],
    ["an akeru_list_routines override", deny(AKERU_LIST_ROUTINES_TOOL_NAME)],
  ])("refuses to list routines under %s", async (_label, policy) => {
    const { list, listedCount } = await setup(policy);

    await expect(list.needsApprovalFn({})).rejects.toThrow("not allowed");
    await expect(list.execute?.({}, { agent: { toolCallId: "list-1" } })).rejects.toThrow(
      "not allowed by this bot's permission policy",
    );
    expect(listedCount()).toBe(0);
  });

  it("lists routines only after the owner answers an ask for this exact call", async () => {
    const { list, listedCount, runtime } = await setup({
      ...DEFAULT_BOT_PERMISSION_POLICY,
      toolOverrides: { [AKERU_LIST_ROUTINES_TOOL_NAME]: "ask" },
    });

    await expect(list.needsApprovalFn({})).resolves.toBe(true);
    await expect(list.execute?.({}, { agent: { toolCallId: "list-1" } })).rejects.toThrow(
      "requires approval",
    );
    expect(listedCount()).toBe(0);

    runtime.openNamedApproval(listCall);
    expect(
      runtime.grantNamedApproval({
        ...listCall,
        answeredBy: { kind: "person", personId: BotPermissionPersonId.make("alice") },
      }),
    ).toEqual({ _tag: "Rejected", reason: "wrong-principal" });
    expect(runtime.grantNamedApproval(listCall)).toEqual({ _tag: "Accepted" });

    await expect(list.execute?.({}, { agent: { toolCallId: "list-1" } })).resolves.toEqual(
      routines,
    );
    expect(listedCount()).toBe(1);

    // The grant covered one run, and a replayed answer cannot reopen it.
    expect(runtime.grantNamedApproval(listCall)).toEqual({
      _tag: "Rejected",
      reason: "already-answered",
    });
    await expect(list.execute?.({}, { agent: { toolCallId: "list-1" } })).rejects.toThrow(
      "requires approval",
    );
    expect(listedCount()).toBe(1);
  });
});
