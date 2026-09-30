import { describe, expect, it } from "vite-plus/test";
import {
  BotId,
  DelegationId,
  EnvironmentId,
  ThreadId,
  TurnId,
  type AkeruDelegationRecord,
} from "@t3tools/contracts";

import { scopedThreadKey } from "./scopedEntities";
import { deriveThreadFeedDelegations, type ThreadFeedDelegations } from "./threadActivity";

const environmentId = EnvironmentId.make("env-1");
const threadId = ThreadId.make("thread-1");

const delegation = (id: string, parentThreadId: string): AkeruDelegationRecord => ({
  delegationId: DelegationId.make(id),
  parentDelegationId: null,
  parentBotId: BotId.make("bot-parent"),
  childBotId: BotId.make("bot-child"),
  parentThreadId: ThreadId.make(parentThreadId),
  parentTurnId: TurnId.make("turn-1"),
  ancestorBotIds: [BotId.make("bot-parent")],
  depth: 1,
  task: "Do the thing.",
  expectedResult: "A result.",
  deadline: null,
  access: {
    allowedToolIds: [],
    memoryScopes: [],
    sandbox: null,
    runtimeMode: "approval-required",
    hasUserComputer: false,
    enabledMcpServerIds: [],
    disabledMcpServerIds: [],
    approvalCeiling: "none",
  },
  billedBotId: BotId.make("bot-child"),
  keep: false,
  anchorMessageId: null,
  retryOfDelegationId: null,
  trigger: "bot",
  createdAt: "2026-09-26T10:00:00.000Z",
  updatedAt: "2026-09-26T10:00:00.000Z",
  phase: { _tag: "Queued" },
});

const parse = (json: string) => JSON.parse(json) as ThreadFeedDelegations;

describe("deriveThreadFeedDelegations", () => {
  // P1-1 regression: the selected chat's key comes from scopedThreadKey
  // ("env:id"), while the atom family used to split on "\n" — the split left
  // `threadId` undefined and `threadId.length` threw, crashing the chat
  // screen the moment a chat was selected. The derivation now takes the
  // thread id separately; this test uses the same scoped key shape the hook
  // builds for a selected chat.
  it("resolves delegations for a chat selected via scopedThreadKey parts", () => {
    const [env, thread] = scopedThreadKey(environmentId, threadId).split(":") as [
      EnvironmentId,
      ThreadId,
    ];
    expect(env).toBe(environmentId);

    const result = parse(deriveThreadFeedDelegations(thread, [delegation("d-1", "thread-1")]));

    expect(result.delegations.map((entry) => entry.delegationId)).toEqual(["d-1"]);
    expect(result.waitingOnChildren).toBe(true);
  });

  it("scopes delegations to the selected thread and reports no waiting otherwise", () => {
    const result = parse(
      deriveThreadFeedDelegations(threadId, [delegation("d-other", "thread-2")]),
    );

    expect(result.delegations).toEqual([]);
    expect(result.waitingOnChildren).toBe(false);
  });

  it("returns the empty slice when no chat is selected", () => {
    expect(parse(deriveThreadFeedDelegations(undefined, undefined))).toEqual({
      delegations: [],
      waitingOnChildren: false,
    });
  });
});
