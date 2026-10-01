import {
  AkeruDelegationRecord,
  BotId,
  GroupId,
  McpServerId,
  ProjectId,
  ProviderInstanceId,
  RoutineId,
  RoutineRunId,
  SkillAssignmentId,
  SkillId,
  ThreadId,
} from "@akeru/contracts";
import * as Schema from "effect/Schema";
import type { OrchestrationShellSnapshot } from "@akeru/contracts";

export const baseSnapshot: OrchestrationShellSnapshot = {
  snapshotSequence: 0,
  bots: [],
  groups: [],
  delegations: [],
  projects: [],
  threads: [],
  updatedAt: "2026-04-01T00:00:00.000Z",
};

const decodeDelegationRecord = Schema.decodeUnknownSync(AkeruDelegationRecord);

export const stubDelegation = decodeDelegationRecord({
  delegationId: "delegation-1",
  parentDelegationId: null,
  parentBotId: "bot-parent",
  childBotId: "bot-child",
  parentThreadId: "thread-parent",
  parentTurnId: "turn-parent",
  ancestorBotIds: ["bot-parent"],
  depth: 1,
  task: "Compare the release options.",
  expectedResult: "A short comparison.",
  deadline: null,
  access: {
    allowedToolIds: ["Read"],
    memoryScopes: ["project"],
    sandbox: "local",
    runtimeMode: "approval-required",
    hasUserComputer: false,
    enabledMcpServerIds: [],
    disabledMcpServerIds: [],
    approvalCeiling: "none",
  },
  phase: { _tag: "Queued" },
  billedBotId: "bot-child",
  keep: false,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
});

export const completedDelegation = (delegationId: string, createdAt: string, updatedAt: string) =>
  decodeDelegationRecord({
    ...stubDelegation,
    delegationId,
    createdAt,
    updatedAt,
    phase: {
      _tag: "Completed",
      childThreadId: "thread-child",
      childTurnId: null,
      startedAt: createdAt,
      completedAt: updatedAt,
      result: { summary: "Finished", childThreadId: "thread-child", childTurnId: null },
      acknowledgedAt: null,
    },
  });

export const stubProject = {
  id: ProjectId.make("project-1"),
  title: "Test Project",
  workspaceRoot: "/workspace/test",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
} as const;

export const stubMcpServer = {
  id: McpServerId.make("mcp-server-1"),
  name: "Filesystem",
  transport: "stdio" as const,
  command: "bunx",
  args: ["@modelcontextprotocol/server-filesystem"],
  enabled: true,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
};

export const stubBot = {
  id: BotId.make("bot-1"),
  name: "Builder",
  title: "Backend engineer",
  label: null,
  description: null,
  disabledMcpServerIds: [],
  avatar: { kind: "dither" as const, seed: "builder" },
  engine: null,
  sandbox: "local" as const,
  runtimeMode: "full-access" as const,
  usageCap: null,
  imageProvider: null,
  voiceEnabled: false,
  channelBindings: [],
  groupId: null,
  archivedAt: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
};

export const stubGroup = {
  id: GroupId.make("group-1"),
  name: "Engineering",
  bossBotId: stubBot.id,
  members: [{ kind: "bot" as const, botId: stubBot.id, role: "boss" as const }],
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
};

export const stubThread = {
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Test Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  session: null,
} as const;

export const stubAssignment = {
  id: SkillAssignmentId.make("assignment-1"),
  botId: stubBot.id,
  skillId: SkillId.make("research"),
  name: "Research",
  description: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
};

export const stubRoutine = {
  id: RoutineId.make("routine-1"),
  botId: stubBot.id,
  targetThreadId: stubThread.id,
  job: "Morning brief",
  procedure: "Prepare the morning brief.",
  schedule: { kind: "daily" as const, time: "09:00" },
  timezone: "UTC",
  skillAssignmentIds: [stubAssignment.id],
  connectorDependencies: [stubMcpServer.id],
  projectId: stubProject.id,
  sandbox: "local" as const,
  approvalPolicy: "approval-required" as const,
  delegateToBotId: null,
  procedureVersion: 1,
  approvalVersion: 1,
  enabled: true,
  lifecycle: "enabled" as const,
  nextRunAt: "2026-04-02T09:00:00.000Z",
  lastRunAt: null,
  latestResult: null,
  latestFailure: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  deletedAt: null,
};

export const stubRoutineRun = {
  id: RoutineRunId.make("run-1"),
  routineId: stubRoutine.id,
  procedureVersion: 1,
  trigger: "scheduled" as const,
  scheduledFor: "2026-04-02T09:00:00.000Z",
  status: "completed" as const,
  result: { summary: "Prepared the brief." },
  failure: null,
  usageRef: null,
  threadRef: null,
  startedAt: "2026-04-02T09:00:00.000Z",
  completedAt: "2026-04-02T09:01:00.000Z",
  createdAt: "2026-04-02T09:00:00.000Z",
  updatedAt: "2026-04-02T09:01:00.000Z",
};
