import { BotId, DEFAULT_SERVER_SETTINGS, EventId, GroupId, McpServerId, MessageId, ProjectId, ProviderDriverKind, ProviderInstanceId, ThreadId, type OrchestrationReadModel, type PortabilityArchiveRecord, type ServerSettings } from "@akeru/contracts";

import { createEmptyReadModel } from "./orchestration/projector.ts";

import { createPortabilityArchive, portabilityChecksum } from "./portability.ts";


export const NOW = "2026-08-30T12:00:00.000Z";


export const LATER = "2026-08-30T13:00:00.000Z";


export const PROJECT_ID = ProjectId.make("project-portable");


export const THREAD_ID = ThreadId.make("thread-portable");


export const BOT_ID = BotId.make("bot-portable");


export const SPECIALIST_BOT_ID = BotId.make("bot-portable-specialist");


export const GROUP_ID = GroupId.make("group-portable");


export const URL_MCP_ID = McpServerId.make("builtin-search");


export const STDIO_MCP_ID = McpServerId.make("local-tool");


export const AVAILABLE_PROVIDER_IDS = new Set(["codex", "private"]);


export function makeSnapshot(overrides: Partial<OrchestrationReadModel> = {}): OrchestrationReadModel {
  return {
    ...createEmptyReadModel(NOW),
    snapshotSequence: 7,
    projects: [
      {
        id: PROJECT_ID,
        title: "Portable project",
        workspaceRoot: "/Users/leo/work/portable-project",
        repositoryIdentity: {
          canonicalKey: "github.com/example/private",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "git@github.com:example/private.git",
          },
          rootPath: "/Users/leo/work/portable-project",
          displayName: "example/private",
          provider: "github",
          owner: "example",
          name: "private",
        },
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-sol",
        },
        scripts: [
          {
            id: "secret-script",
            name: "Deploy",
            command: "printenv TOKEN",
            icon: "build",
            runOnWorktreeCreate: false,
          },
        ],
        faviconPath: "/Users/leo/work/portable-project/icon.png",
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
    ],
    mcpServers: [
      {
        id: URL_MCP_ID,
        name: "Search",
        transport: "url",
        url: "https://user:password@example.com/mcp?token=secret#private",
        enabled: true,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: STDIO_MCP_ID,
        name: "Local tool",
        transport: "stdio",
        command: "/Users/leo/.local/bin/local-tool",
        args: [
          "serve",
          "--config",
          "/Users/leo/.config/local-tool.json",
          "API_KEY=secret",
          "--token",
          "secret-value",
          "postgres://user:hunter2@example.com/database",
          '{"apiKey":"json-secret-value"}',
          "--safe",
        ],
        enabled: true,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    bots: [
      {
        id: BOT_ID,
        name: "Akeru",
        title: "Builder",
        label: null,
        description: [
          "Builds the project",
          '{"apiKey":"json-secret-value"}',
          "-----BEGIN PRIVATE KEY-----\nprivate-key-value\n-----END PRIVATE KEY-----",
          "postgres://user:hunter2@example.com/database",
          "xai-private-value",
          "eyJhbGciOiJIUzI1NiJ9.cHJpdmF0ZQ.c2lnbmF0dXJl",
          "npm_private-package-token",
          "glpat-private-gitlab-token",
          "sk_live_private-stripe-token",
          "~/.ssh/id_rsa",
        ].join("\n"),
        disabledMcpServerIds: [STDIO_MCP_ID, McpServerId.make("deleted-server")],
        avatar: {
          kind: "image",
          assetPath: "/Users/leo/.akeru/avatars/private.png",
          dithered: true,
        },
        engine: { provider: "codex", model: "gpt-5.6-sol" },
        sandbox: "local",
        runtimeMode: "full-access",
        usageCap: null,
        imageProvider: null,
        voiceEnabled: true,
        channelBindings: [],
        groupId: GROUP_ID,
        archivedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    groups: [
      {
        id: GROUP_ID,
        name: "Builders",
        bossBotId: BOT_ID,
        members: [{ kind: "bot", botId: BOT_ID, role: "boss" }],
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    threads: [
      {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        botId: BOT_ID,
        groupId: null,
        respondingBotId: BOT_ID,
        title: "Portable thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-sol",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "refs/heads/private-branch",
        worktreePath: "/Users/leo/work/portable-project",
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: LATER,
        snoozedAt: NOW,
        pinnedAt: NOW,
        deletedAt: null,
        messages: [
          {
            id: MessageId.make("message-secret"),
            role: "user",
            text: [
              "Authorization: Bearer private-token",
              "COOKIE=session-secret",
              "CODEX_HOME=/Users/leo/.codex",
              "refs/heads/private-branch",
              "/Users/leo/work/portable-project/private.txt",
            ].join("\n"),
            turnId: null,
            streaming: false,
            createdAt: NOW,
            updatedAt: NOW,
          },
          {
            id: MessageId.make("message-diff"),
            role: "assistant",
            text: "diff --git a/private.ts b/private.ts\n+secret\n-public",
            turnId: null,
            streaming: false,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
        proposedPlans: [
          {
            id: "plan-private",
            turnId: null,
            planMarkdown: "Read /Users/leo/private.txt with token=private-plan-token",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
        activities: [
          {
            id: EventId.make("event-private"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Contains private payload",
            payload: { token: "approval-secret" },
            turnId: null,
            sequence: 991,
            createdAt: NOW,
          },
        ],
        checkpoints: [],
        session: null,
      },
    ],
    ...overrides,
  };
}


export function makePreflightSnapshot(): OrchestrationReadModel {
  const snapshot = makeSnapshot();
  const boss = snapshot.bots[0]!;

  return {
    ...snapshot,
    bots: [
      boss,
      {
        ...boss,
        id: SPECIALIST_BOT_ID,
        name: "Verifier",
        title: "QA engineer",
        avatar: { kind: "dither", seed: SPECIALIST_BOT_ID },
      },
    ],
    groups: [
      {
        ...snapshot.groups[0]!,
        members: [
          { kind: "bot", botId: BOT_ID, role: "boss" },
          { kind: "bot", botId: SPECIALIST_BOT_ID, role: "specialist" },
        ],
      },
    ],
  };
}


export function makeSettings(): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    enableProviderUpdateChecks: false,
    enableAgentBrowserAccess: false,
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      codex: {
        ...DEFAULT_SERVER_SETTINGS.providers.codex,
        binaryPath: "/Users/leo/.local/bin/codex",
        homePath: "/Users/leo/.codex",
        launchArgs: "--token provider-secret",
      },
    },
    providerInstances: {
      [ProviderInstanceId.make("private")]: {
        driver: ProviderDriverKind.make("codex"),
        environment: [{ name: "OPENAI_API_KEY", value: "provider-secret", sensitive: true }],
        config: { opaqueSecret: "provider-secret" },
      },
    },
  };
}




export function resignArchive(
  archive: ReturnType<typeof createPortabilityArchive>,
  records: readonly PortabilityArchiveRecord[],
): ReturnType<typeof createPortabilityArchive> {
  const signedRecords = records.map((record) => {
    const { checksum: _checksum, ...core } = record;
    return { ...core, checksum: portabilityChecksum(core) } as PortabilityArchiveRecord;
  });
  const body = { ...archive, records: signedRecords };
  const { checksum: _checksum, ...unsigned } = body;
  return { ...unsigned, checksum: portabilityChecksum(unsigned) };
}
