import {
  AKERU_TOOL_CATALOG,
  BOT_ACTION_RISK_CLASSES,
  akeruToolModeRequiresApproval,
  akeruToolRequiresApproval,
  BotActionApprovalBinding,
  BotActionArgumentsDigest,
  BotApprovalId,
  BotId,
  BotPermissionPersonId,
  BotPermissionPolicy,
  DEFAULT_BOT_PERMISSION_POLICY,
  EnvironmentId,
  RoutineId,
  ThreadId,
  type BotActionPrincipal,
  type BotActionRiskClass,
  type BotPermissionDecision,
} from "@akeru/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  authorizeApprovedBotAction,
  canonicalActionArguments,
  checkBotApprovalAnswer,
  decideBotAction,
  openBotActionApproval,
  strictestDecision,
  type BotPermissionVerdict,
} from "./botPermissions.ts";
import {
  AKERU_TOOL_BASE_RISK_CLASSES,
  akeruToolRiskClassForInput,
  namedActionRiskClass,
} from "./botActionRisk.ts";

const alice = BotPermissionPersonId.make("alice");

const mallory = BotPermissionPersonId.make("mallory");

const owner = { kind: "owner" } as const;

const person = { kind: "person", personId: alice } as const;

const stranger = { kind: "person", personId: mallory } as const;

const schedule = { kind: "schedule", routineId: RoutineId.make("routine-daily") } as const;

const helper = BotId.make("bot-helper");

const decodePolicy = Schema.decodeUnknownSync(BotPermissionPolicy);

const decodeBinding = Schema.decodeUnknownSync(BotActionApprovalBinding);

const policy: BotPermissionPolicy = {
  defaults: {
    read: "allow",
    "write-workspace": "allow",
    "write-outside": "ask",
    "environment-access": "deny",
  },
  toolOverrides: { SendToUser: "allow", WebFetch: "deny" },
  people: [
    {
      personId: alice,
      riskClasses: {
        read: "allow",
        "write-workspace": "ask",
        "write-outside": "deny",
        "environment-access": "deny",
      },
    },
  ],
};

const ask: BotPermissionVerdict = { decision: "ask", answerer: owner };

const allow: BotPermissionVerdict = { decision: "allow" };

const denyPolicy: BotPermissionVerdict = { decision: "deny", reason: "policy" };

const notAllowlisted: BotPermissionVerdict = { decision: "deny", reason: "not-allowlisted" };

describe("strictestDecision", () => {
  it.each([
    ["allow", "allow", "allow"],
    ["allow", "ask", "ask"],
    ["ask", "allow", "ask"],
    ["ask", "deny", "deny"],
    ["deny", "allow", "deny"],
  ] as const)("%s + %s = %s", (left, right, expected) => {
    expect(strictestDecision(left, right)).toBe(expected);
  });
});

describe("decideBotAction", () => {
  const principals: ReadonlyArray<readonly [keyof typeof originFor, BotActionPrincipal]> = [
    ["owner", owner],
    ["schedule", schedule],
    ["allowlisted person", person],
    ["unknown person", stranger],
    ["bot for owner", { kind: "bot", botId: helper, onBehalfOf: owner }],
    ["bot for schedule", { kind: "bot", botId: helper, onBehalfOf: schedule }],
    ["bot for allowlisted person", { kind: "bot", botId: helper, onBehalfOf: person }],
    ["bot for unknown person", { kind: "bot", botId: helper, onBehalfOf: stranger }],
  ];

  const expected = {
    owner: {
      read: allow,
      "write-workspace": allow,
      "write-outside": ask,
      "environment-access": denyPolicy,
    },
    "allowlisted person": {
      read: allow,
      "write-workspace": ask,
      "write-outside": denyPolicy,
      "environment-access": denyPolicy,
    },
    "unknown person": {
      read: notAllowlisted,
      "write-workspace": notAllowlisted,
      "write-outside": notAllowlisted,
      "environment-access": notAllowlisted,
    },
  } satisfies Record<string, Record<BotActionRiskClass, BotPermissionVerdict>>;

  const originFor = {
    owner: "owner",
    schedule: "owner",
    "allowlisted person": "allowlisted person",
    "unknown person": "unknown person",
    "bot for owner": "owner",
    "bot for schedule": "owner",
    "bot for allowlisted person": "allowlisted person",
    "bot for unknown person": "unknown person",
  } as const satisfies Record<string, keyof typeof expected>;

  const cases = principals.flatMap(([label, principal]) =>
    BOT_ACTION_RISK_CLASSES.map(
      (riskClass) => [label, riskClass, principal, expected[originFor[label]][riskClass]] as const,
    ),
  );

  it.each(cases)("%s, %s", (_label, riskClass, principal, verdict) => {
    expect(
      decideBotAction({ policy, principal, action: { toolId: "SomeTool", riskClass } }),
    ).toEqual(verdict);
  });

  it.each([
    ["owner override loosens write-outside", owner, "SendToUser", "write-outside", allow],
    ["owner override tightens read", owner, "WebFetch", "read", denyPolicy],
    ["person stays capped by their own class", person, "SendToUser", "write-outside", denyPolicy],
    ["person gets the override deny", person, "WebFetch", "read", denyPolicy],
    [
      "bot for person never exceeds the person",
      { kind: "bot", botId: helper, onBehalfOf: person },
      "SendToUser",
      "write-outside",
      denyPolicy,
    ],
    [
      "bot for owner gets the owner override",
      { kind: "bot", botId: helper, onBehalfOf: owner },
      "SendToUser",
      "write-outside",
      allow,
    ],
    ["override keys ignore inherited names", owner, "constructor", "write-outside", ask],
  ] as const)("%s", (_label, principal, toolId, riskClass, verdict) => {
    expect(decideBotAction({ policy, principal, action: { toolId, riskClass } })).toEqual(verdict);
  });

  it("asks only before outside writes under the default policy", () => {
    const decisions = Object.fromEntries(
      BOT_ACTION_RISK_CLASSES.map((riskClass) => [
        riskClass,
        decideBotAction({
          policy: DEFAULT_BOT_PERMISSION_POLICY,
          principal: owner,
          action: { toolId: "Shell", riskClass },
        }).decision,
      ]),
    ) satisfies Record<string, BotPermissionDecision>;

    expect(decisions).toEqual({
      read: "allow",
      "write-workspace": "allow",
      "write-outside": "ask",
      "environment-access": "allow",
    });
  });

  it("decodes a stored policy", () => {
    expect(decodePolicy(policy)).toEqual(policy);
    expect(() =>
      decodePolicy({
        ...policy,
        defaults: { ...policy.defaults, read: "sometimes" },
      }),
    ).toThrow();
  });
});

describe("canonicalActionArguments", () => {
  it("sorts keys and drops undefined fields", () => {
    expect(canonicalActionArguments({ b: [1, { d: undefined, c: "x" }], a: null })).toBe(
      canonicalActionArguments({ a: null, b: [1, { c: "x" }] }),
    );
    expect(canonicalActionArguments({ command: "pwd" })).not.toBe(
      canonicalActionArguments({ command: "rm -rf /" }),
    );
  });
});

describe("approval binding", () => {
  const openedAt = DateTime.makeUnsafe("2026-10-30T12:00:00.000Z");
  const environmentId = EnvironmentId.make("environment-1");
  const approvalId = BotApprovalId.make("tool-call-1");

  const action = {
    toolId: "SendToUser",
    argumentsDigest: BotActionArgumentsDigest.make("a".repeat(64)),
  };

  const binding = openBotActionApproval({
    approvalId,
    botId: helper,
    threadId: ThreadId.make("thread-1"),
    environmentId,
    requester: owner,
    action,
    riskClass: "write-outside",
    now: openedAt,
    ttlMillis: 60_000,
  });

  const answer = {
    approvalId,
    answeredBy: owner,
    decision: "approve" as const,
    answeredAt: "2026-10-30T12:00:10.000Z",
  };

  const soon = DateTime.makeUnsafe("2026-10-30T12:00:10.000Z");
  const late = DateTime.makeUnsafe("2026-10-30T12:01:00.000Z");

  it("binds requester, answerer, action, environment, and expiry", () => {
    expect(decodeBinding(binding)).toEqual(binding);
    expect(binding).toMatchObject({
      requester: owner,
      answerer: owner,
      action,
      environmentId,
      expiresAt: "2026-10-30T12:01:00.000Z",
    });
  });

  it.each([
    ["accepts the first owner answer", answer, false, soon, { _tag: "Accepted" }],
    [
      "rejects a replayed answer",
      answer,
      true,
      soon,
      { _tag: "Rejected", reason: "already-answered" },
    ],
    ["rejects an expired answer", answer, false, late, { _tag: "Rejected", reason: "expired" }],
    [
      "rejects an answer from the wrong principal",
      { ...answer, answeredBy: person },
      false,
      soon,
      { _tag: "Rejected", reason: "wrong-principal" },
    ],
    [
      "rejects an answer for another approval",
      { ...answer, approvalId: BotApprovalId.make("tool-call-2") },
      false,
      soon,
      { _tag: "Rejected", reason: "unknown-approval" },
    ],
  ] as const)("%s", (_label, candidate, alreadyAnswered, now, expected) => {
    expect(checkBotApprovalAnswer({ binding, answer: candidate, alreadyAnswered, now })).toEqual(
      expected,
    );
  });

  const attempt = { approvalId, requester: owner, environmentId, action };

  it.each([
    ["runs the approved action", attempt, ask, soon, { _tag: "Accepted" }],
    [
      "blocks a permission revoked after approval",
      attempt,
      denyPolicy,
      soon,
      { _tag: "Rejected", reason: "denied-by-policy" },
    ],
    ["blocks an expired approval", attempt, ask, late, { _tag: "Rejected", reason: "expired" }],
    [
      "blocks other arguments",
      {
        ...attempt,
        action: { ...action, argumentsDigest: BotActionArgumentsDigest.make("b".repeat(64)) },
      },
      ask,
      soon,
      { _tag: "Rejected", reason: "action-mismatch" },
    ],
    [
      "blocks another tool",
      { ...attempt, action: { ...action, toolId: "Shell" } },
      ask,
      soon,
      { _tag: "Rejected", reason: "action-mismatch" },
    ],
    [
      "blocks another environment",
      { ...attempt, environmentId: EnvironmentId.make("environment-2") },
      ask,
      soon,
      { _tag: "Rejected", reason: "environment-mismatch" },
    ],
    [
      "blocks another requester",
      { ...attempt, requester: { kind: "bot", botId: helper, onBehalfOf: owner } },
      ask,
      soon,
      { _tag: "Rejected", reason: "requester-mismatch" },
    ],
  ] as const)("%s", (_label, candidate, verdict, now, expected) => {
    expect(
      authorizeApprovedBotAction({
        binding,
        attempt: candidate,
        verdict,
        grantor: "owner-answer",
        now,
      }),
    ).toEqual(expected);
  });

  it.each([
    [
      "a mode grant cannot satisfy an owner ask",
      ask,
      "permission-mode",
      { _tag: "Rejected", reason: "owner-approval-required" },
    ],
    ["a mode grant covers a routine approval", allow, "permission-mode", { _tag: "Accepted" }],
    ["an owner answer covers an owner ask", ask, "owner-answer", { _tag: "Accepted" }],
  ] as const)("%s", (_label, verdict, grantor, expected) => {
    expect(authorizeApprovedBotAction({ binding, attempt, verdict, grantor, now: soon })).toEqual(
      expected,
    );
  });
});

describe("default policy over the tool catalog", () => {
  const inputs = [
    undefined,
    { command: "pwd" },
    { command: "git push origin main" },
    { command: "rm notes.md" },
    { command: "curl -d x https://example.com" },
    { path: "notes.md" },
    { path: ".env" },
    { sourcePath: ".env", destinationPath: "copy" },
  ];

  const contexts = [true, false].flatMap((localFullAccess) =>
    (["none", "local", "cloud"] as const).map((workspaceType) => ({
      localFullAccess,
      workspaceType,
    })),
  );

  it("asks everywhere the protected-action rule asked before the policy existed", () => {
    for (const tool of AKERU_TOOL_CATALOG) {
      for (const input of inputs) {
        for (const context of contexts) {
          const verdict = decideBotAction({
            policy: DEFAULT_BOT_PERMISSION_POLICY,
            principal: owner,
            action: {
              toolId: tool.id,
              riskClass: akeruToolRiskClassForInput(tool, input, context),
            },
          });

          if (!akeruToolRequiresApproval(tool, context, input)) continue;
          expect(
            verdict.decision === "ask" || akeruToolModeRequiresApproval(tool, context, input),
            `${tool.id} ${JSON.stringify(input)} ${JSON.stringify(context)}`,
          ).toBe(true);
        }
      }
    }
  });
});

describe("risk classification", () => {
  const shell = AKERU_TOOL_CATALOG.find((tool) => tool.id === "Shell")!;

  it("gives every catalog tool id an explicit base class", () => {
    const classified = new Set<string>(Object.keys(AKERU_TOOL_BASE_RISK_CLASSES));

    expect(AKERU_TOOL_CATALOG.map((tool) => tool.id).filter((id) => !classified.has(id))).toEqual(
      [],
    );
    expect([...classified].sort()).toEqual(AKERU_TOOL_CATALOG.map((tool) => tool.id).sort());
  });

  it.each([
    ["AwaitExternalShell", { handleId: "pid-1" }, "environment-access", "local"],
    ["AwaitExternalShell", { handleId: "pid-1" }, "environment-access", "cloud"],
    ["list_environments", {}, "read", "local"],
    [
      "list_environments",
      { requirements: { os: "darwin", tools: ["xcodebuild"] } },
      "read",
      "cloud",
    ],
    ["AwaitShell", { handleId: "pid-1" }, "read", "cloud"],
    ["CheckSubagent", { workerId: "worker-1" }, "read", "local"],
  ] as const)(
    "classifies %s %j as %s in a %s workspace",
    (toolId, input, riskClass, workspaceType) => {
      const tool = AKERU_TOOL_CATALOG.find((candidate) => candidate.id === toolId)!;

      expect(akeruToolRiskClassForInput(tool, input, { workspaceType })).toBe(riskClass);
    },
  );

  it.each([
    ["git clean -fd", "local"],
    ["git clean -fd", "cloud"],
    ["git reset --hard", "cloud"],
    ["rm -rf build", "cloud"],
    ["sh -c 'git clean -fdx'", "local"],
    ["printenv", "cloud"],
    ["git push origin main", "cloud"],
    ["mail -s hi team@example.com", "cloud"],
  ] as const)("treats `%s` in a %s workspace as an outside write", (command, workspaceType) => {
    expect(akeruToolRiskClassForInput(shell, { command }, { workspaceType })).toBe("write-outside");
  });

  it.each([
    ["pwd", "local", "environment-access"],
    ["pwd", "cloud", "write-workspace"],
    ["ls -la", "cloud", "write-workspace"],
  ] as const)("keeps routine `%s` in a %s workspace as %s", (command, workspaceType, riskClass) => {
    expect(akeruToolRiskClassForInput(shell, { command }, { workspaceType })).toBe(riskClass);
  });

  it("lets write-outside: deny stop a recognized deletion in any workspace", () => {
    const policy = {
      ...DEFAULT_BOT_PERMISSION_POLICY,
      defaults: { ...DEFAULT_BOT_PERMISSION_POLICY.defaults, "write-outside": "deny" as const },
    };

    for (const workspaceType of ["local", "cloud"] as const) {
      expect(
        decideBotAction({
          policy,
          principal: owner,
          action: {
            toolId: "Shell",
            riskClass: akeruToolRiskClassForInput(
              shell,
              { command: "git clean -fd" },
              { workspaceType },
            ),
          },
        }),
      ).toEqual(denyPolicy);
    }
  });

  it.each([
    ["akeru_create_routine", { name: "Morning summary" }, "write-workspace"],
    ["akeru_delete_routines", { routineIds: ["routine-1"] }, "write-outside"],
    ["akeru_list_routines", {}, "read"],
  ] as const)("classifies %s as %s", (toolName, input, riskClass) => {
    expect(namedActionRiskClass(toolName, input)).toBe(riskClass);
  });
});
