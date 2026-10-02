import {
  BotId,
  DEFAULT_SERVER_SETTINGS,
  GroupId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationBot,
  type OrchestrationGroup,
  type OrchestrationThreadShell,
  type ServerConfig,
} from "@akeru/contracts";

const timestamp = "2026-01-01T00:00:00Z";

export function makeMobileBot(overrides: Partial<OrchestrationBot> = {}): OrchestrationBot {
  return {
    id: BotId.make("bot-1"),
    name: "Mira",
    title: "Assistant",
    label: null,
    description: null,
    disabledMcpServerIds: [],
    avatar: { kind: "blob", shape: "circle", color: "#E0645C" },
    engine: null,
    sandbox: null,
    runtimeMode: "full-access",
    usageCap: null,
    imageProvider: null,
    voiceEnabled: false,
    channelBindings: [],
    groupId: null,
    archivedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

export function makeMobileGroup(overrides: Partial<OrchestrationGroup> = {}): OrchestrationGroup {
  return {
    id: GroupId.make("group-1"),
    name: "Mira and Ren",
    bossBotId: null,
    members: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

export function makeMobileThreadShell(
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id: ThreadId.make("thread"),
    projectId: ProjectId.make("project"),
    title: "Chat",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: timestamp,
    updatedAt: timestamp,
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
}

export function makeMobileServerConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    environment: {
      environmentId: EnvironmentId.make("environment"),
      label: "Test",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "1.0.0",
      capabilities: { repositoryIdentity: false },
    },
    auth: {
      policy: "unsafe-no-auth",
      bootstrapMethods: [],
      sessionMethods: [],
      sessionCookieName: "session",
    },
    cwd: "/workspace",
    keybindingsConfigPath: "/workspace/keybindings.json",
    keybindings: [],
    issues: [],
    providers: [],
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/tmp/logs",
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: DEFAULT_SERVER_SETTINGS,
    ...overrides,
  };
}
