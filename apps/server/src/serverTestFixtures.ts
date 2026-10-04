import {
  BotId,
  EnvironmentId,
  EventId,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type OrchestrationEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@akeru/contracts";

import * as DateTime from "effect/DateTime";

export const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

export const defaultProjectId = ProjectId.make("project-default");

export const defaultThreadId = ThreadId.make("thread-default");

export const defaultDesktopBootstrapToken = "test-desktop-bootstrap-token";

export const defaultModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
} as const;

export const worktreeTestModelSelection = {
  instanceId: ProviderInstanceId.make("opencode"),
  model: "test-model",
} as const;

export const readyWorktreeProvider = {
  instanceId: worktreeTestModelSelection.instanceId,
  driver: ProviderDriverKind.make("opencode"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready" as const,
  auth: { status: "authenticated" as const },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

export const readyDefaultProvider = {
  ...readyWorktreeProvider,
  instanceId: defaultModelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
};

export const makeLiveToolActivityEvent = (
  sequence: number,
  kind: OrchestrationThreadActivity["kind"] = "tool.updated",
): Extract<OrchestrationEvent, { type: "thread.activity-appended" }> => {
  const activity: OrchestrationThreadActivity = {
    id: EventId.make(`activity-${sequence}`),
    tone: "tool",
    kind,
    summary: "Editing app.ts",
    payload: {
      itemType: "file_change",
      title: "Editing app.ts",
      data: { toolCallId: "call-edit", path: "src/app.ts" },
    },
    turnId: TurnId.make("turn-edit"),
    createdAt: "2026-01-01T00:00:01.000Z",
  };

  return {
    sequence,
    eventId: EventId.make(`event-tool-${sequence}`),
    aggregateKind: "thread",
    aggregateId: defaultThreadId,
    occurredAt: "2026-01-01T00:00:01.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.activity-appended",
    payload: { threadId: defaultThreadId, activity },
  };
};

export const testEnvironmentDescriptor = {
  environmentId: EnvironmentId.make("environment-test"),
  label: "Test environment",
  platform: {
    os: "darwin" as const,
    arch: "arm64" as const,
  },
  serverVersion: "0.0.0-test",
  capabilities: {
    repositoryIdentity: true,
  },
};

export const defaultOrchestrationReadModel = () => {
  const now = "2026-01-01T00:00:00.000Z";

  return {
    snapshotSequence: 0,
    updatedAt: now,
    bots: [],
    groups: [],
    delegations: [],
    projects: [
      {
        id: defaultProjectId,
        title: "Default Project",
        workspaceRoot: "/tmp/default-project",
        defaultModelSelection,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: defaultThreadId,
        projectId: defaultProjectId,
        title: "Default Thread",
        modelSelection: defaultModelSelection,
        interactionMode: "default" as const,
        runtimeMode: "full-access" as const,
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        latestTurn: null,
        messages: [],
        session: null,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        deletedAt: null,
      },
    ],
  };
};

export const makeChannelTestBot = () => ({
  id: BotId.make("bot-channel-test"),
  name: "Channel bot",
  title: "Agent",
  label: null,
  description: null,
  disabledMcpServerIds: [],
  avatar: { kind: "dither" as const, seed: "channel-bot" },
  engine: null,
  sandbox: "local" as const,
  runtimeMode: "full-access" as const,
  voiceEnabled: false,
  imageProvider: null,
  channelBindings: [],
  groupId: null,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

export const makeDefaultOrchestrationThreadShell = (
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell => {
  const now = "2026-01-01T00:00:00.000Z";

  return {
    id: defaultThreadId,
    projectId: defaultProjectId,
    title: "Default Thread",
    modelSelection: defaultModelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
};
