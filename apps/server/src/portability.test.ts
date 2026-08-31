import {
  AuthSessionId,
  BotId,
  DEFAULT_SERVER_SETTINGS,
  EventId,
  GroupId,
  McpServerId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type PortabilityArchiveRecord,
  type ServerSettings,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { decideCommandSequence } from "./orchestration/decider.ts";
import { createEmptyReadModel } from "./orchestration/projector.ts";
import {
  canonicalJson,
  commandsForPortabilityImport,
  createPortabilityArchive,
  isPortabilityPreviewCurrent,
  parsePortabilityArchive,
  portabilityChecksum,
  portableRecords,
  previewPortabilityImport,
  serializePortabilityArchive,
  summarizePortabilityApply,
} from "./portability.ts";

const NOW = "2026-08-30T12:00:00.000Z";
const LATER = "2026-08-30T13:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-portable");
const THREAD_ID = ThreadId.make("thread-portable");
const BOT_ID = BotId.make("bot-portable");
const GROUP_ID = GroupId.make("group-portable");
const URL_MCP_ID = McpServerId.make("builtin-search");
const STDIO_MCP_ID = McpServerId.make("local-tool");
const AVAILABLE_PROVIDER_IDS = new Set(["codex", "private"]);

function makeSnapshot(overrides: Partial<OrchestrationReadModel> = {}): OrchestrationReadModel {
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

function makeSettings(): ServerSettings {
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

function resignArchive(
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

describe("portability archive", () => {
  it("creates deterministic sorted records and an exact manifest", () => {
    const snapshot = makeSnapshot();
    const settings = makeSettings();
    const first = createPortabilityArchive(snapshot, settings, NOW);
    const second = createPortabilityArchive(snapshot, settings, NOW);

    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(first.records.map((record) => `${record.type}:${record.id}`)).toEqual(
      [...first.records]
        .sort((left, right) =>
          left.type === right.type
            ? left.id.localeCompare(right.id)
            : left.type.localeCompare(right.type),
        )
        .map((record) => `${record.type}:${record.id}`),
    );
    expect(first.manifest.recordCounts).toEqual({
      bot: 1,
      group: 1,
      "mcp-server": 2,
      project: 1,
      "server-settings": 1,
      thread: 1,
    });
    expect(parsePortabilityArchive(serializePortabilityArchive(first))).toEqual(first);
  });

  it("removes credentials, local state, Git state, and event internals", () => {
    const text = serializePortabilityArchive(
      createPortabilityArchive(makeSnapshot(), makeSettings(), NOW),
    );

    for (const excluded of [
      "private-token",
      "session-secret",
      "provider-secret",
      "OPENAI_API_KEY",
      "/Users/leo",
      "refs/heads/private-branch",
      "diff --git",
      "message-secret",
      "event-private",
      "plan-private",
      "private-plan-token",
      "approval-secret",
      '"sequence": 991',
      "private-branch",
      "secret-script",
      "git@github.com",
      "json-secret-value",
      "private-key-value",
      "hunter2",
      "xai-private-value",
      "eyJhbGciOiJIUzI1NiJ9",
      "npm_private-package-token",
      "glpat-private-gitlab-token",
      "sk_live_private-stripe-token",
      "~/.ssh/id_rsa",
    ]) {
      expect(text).not.toContain(excluded);
    }
    expect(text).toContain('"command": "local-tool"');
    expect(text).toContain('"serve"');
    expect(text).toContain('"--safe"');
    expect(text).toContain('"url": "https://example.com/mcp"');
    expect(text).toContain('"avatar": {\n          "kind": "dither"');
    expect(text).toContain('"approvalHistory"');
    expect(text).toContain('"messages"');
    expect(text).toContain('"proposedPlans"');
  });

  it("omits paired people while preserving bot group membership", () => {
    const snapshot = makeSnapshot();
    const source = {
      ...snapshot,
      groups: [
        {
          ...snapshot.groups[0]!,
          members: [
            ...snapshot.groups[0]!.members,
            {
              kind: "person" as const,
              personId: AuthSessionId.make("person-portable"),
              displayName: "Paired person",
            },
          ],
        },
      ],
    };
    const archive = createPortabilityArchive(source, makeSettings(), NOW);
    const group = archive.records.find((record) => record.type === "group");

    expect(group?.data.members).toEqual([{ kind: "bot", botId: BOT_ID, role: "boss" }]);
    const commandTypes = commandsForPortabilityImport(
      archive,
      source,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
    ).commands.map((command) => command.type);

    expect(commandTypes).not.toContain("group.person.assign");
    expect(commandTypes).not.toContain("group.person.unassign");
  });

  it("rejects paired identities in imported group records", () => {
    const archive = createPortabilityArchive(makeSnapshot(), makeSettings(), NOW);
    const withPerson = resignArchive(
      archive,
      archive.records.map((record) =>
        record.type === "group"
          ? ({
              ...record,
              data: {
                ...record.data,
                members: [
                  ...record.data.members,
                  {
                    kind: "person",
                    personId: AuthSessionId.make("person-imported"),
                    displayName: "Imported person",
                  },
                ],
              },
            } as unknown as PortabilityArchiveRecord)
          : record,
      ),
    );

    expect(() => parsePortabilityArchive(serializePortabilityArchive(withPerson))).toThrow();
  });

  it("allows one bot to belong to multiple groups", () => {
    const secondGroupId = GroupId.make("group-second");
    const source = makeSnapshot({
      groups: [
        makeSnapshot().groups[0]!,
        {
          ...makeSnapshot().groups[0]!,
          id: secondGroupId,
          name: "Second group",
        },
      ],
    });
    const archive = parsePortabilityArchive(
      serializePortabilityArchive(createPortabilityArchive(source, makeSettings(), NOW)),
    );
    const preview = previewPortabilityImport(
      archive,
      makeSnapshot(),
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
    );

    expect(preview.additions).toContainEqual(
      expect.objectContaining({ recordType: "group", id: secondGroupId }),
    );
    expect(preview.conflicts).not.toContainEqual(expect.objectContaining({ recordType: "group" }));
  });

  it("omits deleted threads and projects and does not restore over them", () => {
    const base = makeSnapshot();
    const deletedProjectId = ProjectId.make("project-deleted");
    const deletedThreadId = ThreadId.make("thread-deleted");
    const snapshot = {
      ...base,
      projects: [
        ...base.projects,
        {
          ...base.projects[0]!,
          id: deletedProjectId,
          title: "Deleted secret project",
          deletedAt: NOW,
        },
      ],
      threads: [
        ...base.threads,
        {
          ...base.threads[0]!,
          id: deletedThreadId,
          title: "Deleted secret thread",
          deletedAt: NOW,
        },
      ],
    };
    const text = serializePortabilityArchive(
      createPortabilityArchive(snapshot, makeSettings(), NOW),
    );
    expect(text).not.toContain("Deleted secret project");
    expect(text).not.toContain("Deleted secret thread");
    expect(text).not.toContain("project-deleted");
    expect(text).not.toContain("thread-deleted");

    const archive = createPortabilityArchive(makeSnapshot(), makeSettings(), NOW);
    const target = {
      ...base,
      threads: [{ ...base.threads[0]!, deletedAt: NOW }],
    };
    const preview = previewPortabilityImport(
      archive,
      target,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
    );
    expect(preview.conflicts.map((entry) => `${entry.recordType}:${entry.id}`)).toContain(
      "thread:thread-portable",
    );
    const plan = commandsForPortabilityImport(
      archive,
      target,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
    );
    expect(plan.commands.filter((command) => command.type.startsWith("thread."))).toEqual([]);
  });

  it("rejects tampering, unsafe MCP recipes, bad counts, and broken references", () => {
    const archive = createPortabilityArchive(makeSnapshot(), makeSettings(), NOW);
    const changed = {
      ...archive,
      records: archive.records.map((record, index) =>
        index === 0 ? { ...record, updatedAt: LATER } : record,
      ),
    };
    expect(() => parsePortabilityArchive(JSON.stringify(changed))).toThrow("Checksum failed");

    const badMcp = resignArchive(
      archive,
      archive.records.map((record) =>
        record.type === "mcp-server" && record.data.configuration.transport === "stdio"
          ? {
              ...record,
              data: {
                ...record.data,
                configuration: {
                  ...record.data.configuration,
                  args: ["--config=/Users/leo/private.json"],
                },
              },
            }
          : record,
      ),
    );
    expect(() => parsePortabilityArchive(JSON.stringify(badMcp))).toThrow("local path");

    const badCountsBody = {
      ...archive,
      manifest: {
        ...archive.manifest,
        recordCounts: { ...archive.manifest.recordCounts, bot: 99 },
      },
    };
    const { checksum: _badCountsChecksum, ...badCountsUnsigned } = badCountsBody;
    const badCounts = {
      ...badCountsUnsigned,
      checksum: portabilityChecksum(badCountsUnsigned),
    };
    expect(() => parsePortabilityArchive(JSON.stringify(badCounts))).toThrow("record counts");

    const broken = resignArchive(
      archive,
      archive.records.map((record) =>
        record.type === "thread"
          ? { ...record, data: { ...record.data, projectId: ProjectId.make("missing-project") } }
          : record,
      ),
    );
    expect(() => parsePortabilityArchive(JSON.stringify(broken))).toThrow("missing project");

    const unsafeAvatar = resignArchive(
      archive,
      archive.records.map((record) =>
        record.type === "bot"
          ? {
              ...record,
              data: {
                ...record.data,
                avatar: {
                  kind: "image" as const,
                  assetPath: "/Users/leo/.ssh/id_rsa",
                  dithered: false,
                },
              },
            }
          : record,
      ),
    );
    expect(() => parsePortabilityArchive(JSON.stringify(unsafeAvatar))).toThrow(
      "image avatar path",
    );

    const unsafeText = resignArchive(
      archive,
      archive.records.map((record) =>
        record.type === "bot"
          ? { ...record, data: { ...record.data, description: '{"apiKey":"secret"}' } }
          : record,
      ),
    );
    expect(() => parsePortabilityArchive(JSON.stringify(unsafeText))).toThrow("unsafe text");
  });
});

describe("portability import", () => {
  it("previews additions, conflicts, missing providers, skipped secrets, and unsupported state", () => {
    const source = makeSnapshot({
      bots: [
        {
          ...makeSnapshot().bots[0]!,
          engine: { provider: "missing-provider", model: "missing-model" },
        },
      ],
      threads: [
        {
          ...makeSnapshot().threads[0]!,
          modelSelection: {
            instanceId: ProviderInstanceId.make("missing-instance"),
            model: "missing-model",
          },
        },
      ],
    });
    const archive = createPortabilityArchive(source, makeSettings(), NOW);
    const target = makeSnapshot({
      snapshotSequence: 8,
      bots: [],
      groups: [],
      mcpServers: [],
      threads: [],
    });
    const preview = previewPortabilityImport(
      archive,
      target,
      DEFAULT_SERVER_SETTINGS,
      AVAILABLE_PROVIDER_IDS,
    );

    expect(preview.additions.map((entry) => entry.recordType)).toEqual([
      "mcp-server",
      "mcp-server",
    ]);
    expect(preview.changes.map((entry) => entry.recordType)).toEqual(["server-settings"]);
    expect(preview.conflicts.map((entry) => entry.recordType)).toEqual(["bot", "group", "thread"]);
    expect(preview.missingProviders).toEqual(["missing-instance", "missing-provider"]);
    expect(preview.skippedSecrets).toHaveLength(4);
    expect(preview.skippedSecrets).toContain(
      "Paired client identities and group person membership",
    );
    expect(preview.unsupported).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "jobs", count: 0 }),
        expect.objectContaining({ kind: "memory", count: 0 }),
        expect.objectContaining({ kind: "routines", count: 0 }),
        expect.objectContaining({ kind: "skill-assignments", count: 0 }),
        expect.objectContaining({ kind: "usage-history", count: 0 }),
      ]),
    );
  });

  it("uses live provider availability instead of static settings keys", () => {
    const archive = createPortabilityArchive(makeSnapshot(), makeSettings(), NOW);
    const target = makeSnapshot({ bots: [], groups: [], mcpServers: [], threads: [] });
    const preview = previewPortabilityImport(archive, target, makeSettings(), new Set());

    expect(preview.missingProviders).toEqual(["codex"]);
    expect(preview.additions.map((entry) => entry.recordType)).toEqual([
      "mcp-server",
      "mcp-server",
    ]);
    expect(preview.conflicts.map((entry) => entry.recordType)).toEqual([
      "bot",
      "group",
      "project",
      "server-settings",
      "thread",
    ]);
  });

  it("reports newer target records and unrestorable groups as conflicts", () => {
    const archive = createPortabilityArchive(makeSnapshot(), makeSettings(), NOW);
    const newerTarget = makeSnapshot({
      mcpServers: [
        {
          ...makeSnapshot().mcpServers![0]!,
          name: "Target search",
          updatedAt: LATER,
        },
      ],
      groups: [{ ...makeSnapshot().groups[0]!, bossBotId: null, members: [] }],
    });
    const groupWithoutBoss = resignArchive(
      archive,
      archive.records.map((record) =>
        record.type === "group"
          ? { ...record, data: { ...record.data, bossBotId: null, members: [] } }
          : record,
      ),
    );
    const preview = previewPortabilityImport(
      groupWithoutBoss,
      newerTarget,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
    );

    expect(preview.conflicts.map((entry) => `${entry.recordType}:${entry.id}`)).toEqual([
      `group:${GROUP_ID}`,
      `mcp-server:${URL_MCP_ID}`,
    ]);
  });

  it("conflicts with different existing conversation history", () => {
    const source = makeSnapshot();
    const target = makeSnapshot({
      threads: [
        {
          ...makeSnapshot().threads[0]!,
          messages: [
            {
              ...makeSnapshot().threads[0]!.messages[0]!,
              text: "Target-only conversation",
            },
          ],
          proposedPlans: [],
          activities: [],
        },
      ],
    });
    const archive = createPortabilityArchive(source, makeSettings(), NOW);
    const preview = previewPortabilityImport(
      archive,
      target,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
    );

    expect(preview.conflicts).toContainEqual(
      expect.objectContaining({ recordType: "thread", id: THREAD_ID }),
    );
    expect(
      commandsForPortabilityImport(archive, target, makeSettings(), AVAILABLE_PROVIDER_IDS)
        .commands,
    ).not.toContainEqual(expect.objectContaining({ type: "thread.history.restore" }));
  });

  it("does not overwrite newer server settings", () => {
    const preview = previewPortabilityImport(
      createPortabilityArchive(makeSnapshot(), makeSettings(), NOW),
      makeSnapshot({ updatedAt: LATER }),
      DEFAULT_SERVER_SETTINGS,
      AVAILABLE_PROVIDER_IDS,
    );

    expect(preview.conflicts).toContainEqual({
      recordType: "server-settings",
      id: "server-settings",
      title: "Server settings",
    });
  });

  it("updates safe project fields only when the workspace reference matches", () => {
    const sourceProject = {
      ...makeSnapshot().projects[0]!,
      title: "Renamed portable project",
      defaultThreadEnvMode: "worktree" as const,
      updatedAt: LATER,
    };
    const source = makeSnapshot({ projects: [sourceProject], updatedAt: LATER });
    const archive = createPortabilityArchive(source, makeSettings(), LATER);
    const target = makeSnapshot();
    const preview = previewPortabilityImport(
      archive,
      target,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
    );
    const plan = commandsForPortabilityImport(
      archive,
      target,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
    );

    expect(preview.changes).toContainEqual(
      expect.objectContaining({ recordType: "project", id: PROJECT_ID }),
    );
    expect(plan.commands).toContainEqual({
      type: "project.meta.update",
      commandId: expect.any(String),
      projectId: PROJECT_ID,
      title: "Renamed portable project",
      defaultModelSelection: sourceProject.defaultModelSelection,
      defaultThreadEnvMode: "worktree",
    });
    expect(plan.commands).not.toContainEqual(
      expect.objectContaining({ type: "project.meta.update", workspaceRoot: expect.anything() }),
    );
  });

  it("maps projects and threads to a different target project ID by repository identity", () => {
    const targetProjectId = ProjectId.make("project-target");
    const sourceProject = {
      ...makeSnapshot().projects[0]!,
      title: "Renamed portable project",
      updatedAt: LATER,
    };
    const archive = createPortabilityArchive(
      makeSnapshot({ projects: [sourceProject], updatedAt: LATER }),
      makeSettings(),
      LATER,
    );
    const target = makeSnapshot({
      projects: [
        {
          ...makeSnapshot().projects[0]!,
          id: targetProjectId,
          title: "Local project",
          workspaceRoot: "/Volumes/code/private-clone",
        },
      ],
      threads: [],
    });

    const preview = previewPortabilityImport(
      archive,
      target,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
    );
    const plan = commandsForPortabilityImport(
      archive,
      target,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
    );

    expect(preview.changes).toContainEqual(
      expect.objectContaining({ recordType: "project", id: PROJECT_ID }),
    );
    expect(preview.additions).toContainEqual(
      expect.objectContaining({ recordType: "thread", id: THREAD_ID }),
    );
    expect(plan.commands).toContainEqual(
      expect.objectContaining({ type: "project.meta.update", projectId: targetProjectId }),
    );
    expect(plan.commands).toContainEqual(
      expect.objectContaining({ type: "thread.create", projectId: targetProjectId }),
    );
    expect(plan.commandItems).toContainEqual(
      expect.objectContaining({ recordType: "project", id: PROJECT_ID }),
    );
  });

  it("uses an unambiguous workspace name when repository identity is unavailable", () => {
    const targetProjectId = ProjectId.make("project-target");
    const source = makeSnapshot({
      projects: [{ ...makeSnapshot().projects[0]!, repositoryIdentity: null }],
    });
    const target = makeSnapshot({
      projects: [
        {
          ...makeSnapshot().projects[0]!,
          id: targetProjectId,
          workspaceRoot: "/Volumes/code/portable-project",
          repositoryIdentity: null,
        },
      ],
      threads: [],
    });
    const archive = createPortabilityArchive(source, makeSettings(), NOW);
    const plan = commandsForPortabilityImport(
      archive,
      target,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
    );

    expect(plan.commands).toContainEqual(
      expect.objectContaining({ type: "thread.create", projectId: targetProjectId }),
    );
  });

  it("reports ambiguous project matches as conflicts", () => {
    const source = makeSnapshot();
    const baseProject = source.projects[0]!;
    const target = makeSnapshot({
      projects: [
        {
          ...baseProject,
          id: ProjectId.make("project-target-a"),
          workspaceRoot: "/Volumes/a/portable-project",
        },
        {
          ...baseProject,
          id: ProjectId.make("project-target-b"),
          workspaceRoot: "/Volumes/b/portable-project",
        },
      ],
      threads: [],
    });
    const archive = createPortabilityArchive(source, makeSettings(), NOW);
    const preview = previewPortabilityImport(
      archive,
      target,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
    );
    const plan = commandsForPortabilityImport(
      archive,
      target,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
    );

    expect(preview.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ recordType: "project", id: PROJECT_ID }),
        expect.objectContaining({ recordType: "thread", id: THREAD_ID }),
      ]),
    );
    expect(plan.commands.some((command) => command.type.startsWith("project."))).toBe(false);
    expect(plan.commands.some((command) => command.type.startsWith("thread."))).toBe(false);
  });

  it("reports missing project matches as unsupported", () => {
    const archive = createPortabilityArchive(makeSnapshot(), makeSettings(), NOW);
    const target = makeSnapshot({ projects: [], threads: [] });
    const preview = previewPortabilityImport(
      archive,
      target,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
    );
    const plan = commandsForPortabilityImport(
      archive,
      target,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
    );

    expect(preview.unsupported).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "project", count: 1 }),
        expect.objectContaining({ kind: "thread", count: 1 }),
      ]),
    );
    expect(plan.commands.some((command) => command.type.startsWith("project."))).toBe(false);
    expect(plan.commands.some((command) => command.type.startsWith("thread."))).toBe(false);
  });

  it("rejects a stale preview token when projection state changes", () => {
    const snapshot = makeSnapshot();
    const settings = makeSettings();
    const archive = createPortabilityArchive(snapshot, settings, NOW);
    const preview = previewPortabilityImport(archive, snapshot, settings, AVAILABLE_PROVIDER_IDS);

    expect(isPortabilityPreviewCurrent(snapshot, settings, AVAILABLE_PROVIDER_IDS, preview)).toBe(
      true,
    );
    expect(
      isPortabilityPreviewCurrent(
        { ...snapshot, snapshotSequence: 8 },
        settings,
        AVAILABLE_PROVIDER_IDS,
        preview,
      ),
    ).toBe(false);
    expect(
      isPortabilityPreviewCurrent(
        snapshot,
        { ...settings, enableProviderUpdateChecks: !settings.enableProviderUpdateChecks },
        AVAILABLE_PROVIDER_IDS,
        preview,
      ),
    ).toBe(false);
    expect(isPortabilityPreviewCurrent(snapshot, settings, new Set(), preview)).toBe(false);
  });

  it("previews forced MCP disable as a change", () => {
    const snapshot = makeSnapshot();
    const settings = makeSettings();
    const preview = previewPortabilityImport(
      createPortabilityArchive(snapshot, settings, NOW),
      snapshot,
      settings,
      AVAILABLE_PROVIDER_IDS,
    );

    expect(preview.changes.map((entry) => entry.id)).toEqual([URL_MCP_ID, STDIO_MCP_ID]);
  });

  it("plans valid orchestration commands and keeps every restored MCP server disabled", () => {
    const source = makeSnapshot();
    const archive = createPortabilityArchive(source, makeSettings(), NOW);
    const target = makeSnapshot({
      bots: [],
      groups: [],
      mcpServers: [
        {
          id: URL_MCP_ID,
          name: "Old search",
          transport: "url" as const,
          url: "https://example.com/mcp",
          enabled: true,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      threads: [],
    });
    const first = commandsForPortabilityImport(
      archive,
      target,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
    );
    const second = commandsForPortabilityImport(
      archive,
      target,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
    );

    expect(first.commands.map((command) => command.type)).toEqual(
      expect.arrayContaining([
        "mcp-server.update",
        "mcp-server.disable",
        "mcp-server.create",
        "bot.create",
        "group.create",
        "thread.create",
        "thread.history.restore",
      ]),
    );
    expect(first.commands).toContainEqual(
      expect.objectContaining({
        type: "mcp-server.create",
        mcpServerId: STDIO_MCP_ID,
        enabled: false,
      }),
    );
    expect(first.commands).toContainEqual(
      expect.objectContaining({ type: "mcp-server.disable", mcpServerId: URL_MCP_ID }),
    );
    expect(first.commands).not.toContainEqual(
      expect.objectContaining({ type: "mcp-server.disable", mcpServerId: STDIO_MCP_ID }),
    );
    expect(
      first.commands.findIndex(
        (command) => command.type === "mcp-server.disable" && command.mcpServerId === URL_MCP_ID,
      ),
    ).toBeLessThan(
      first.commands.findIndex(
        (command) => command.type === "mcp-server.update" && command.mcpServerId === URL_MCP_ID,
      ),
    );
    expect(first.commands).not.toContainEqual(expect.objectContaining({ type: "bot.restore" }));
    expect(first.commands.map((command) => command.commandId)).not.toEqual(
      second.commands.map((command) => command.commandId),
    );
    expect(first.applied).toBeGreaterThan(0);
  });

  effectIt.effect("preflights the complete restore plan through the decider", () => {
    const source = makeSnapshot();
    const target = makeSnapshot({ bots: [], groups: [], mcpServers: [], threads: [] });
    const commands = commandsForPortabilityImport(
      createPortabilityArchive(source, makeSettings(), NOW),
      target,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
    ).commands;
    const historyCommand = commands.find((command) => command.type === "thread.history.restore");

    return decideCommandSequence({ commands, readModel: target }).pipe(
      Effect.tap((events) =>
        Effect.sync(() => {
          expect(events.length).toBeGreaterThan(0);
          expect(events.map((event) => event.type)).toEqual(
            expect.arrayContaining([
              "thread.message-sent",
              "thread.proposed-plan-upserted",
              "thread.activity-appended",
              "thread.snoozed",
              "thread.pinned",
            ]),
          );
          expect(
            events.find((event) => event.type === "thread.activity-appended")?.payload,
          ).toEqual(
            expect.objectContaining({
              activity: expect.objectContaining({ kind: "approval.history" }),
            }),
          );
          expect(
            events
              .filter((event) => event.commandId === historyCommand?.commandId)
              .every((event) => event.metadata.importedHistory === true),
          ).toBe(true);
        }),
      ),
      Effect.provide(NodeServices.layer),
    );
  });

  it("sets a replacement boss before changing the remaining membership", () => {
    const secondBotId = BotId.make("bot-second");
    const source = makeSnapshot({
      bots: [
        makeSnapshot().bots[0]!,
        {
          ...makeSnapshot().bots[0]!,
          id: secondBotId,
          name: "Second",
          avatar: { kind: "dither", seed: secondBotId },
        },
      ],
      groups: [
        {
          ...makeSnapshot().groups[0]!,
          bossBotId: secondBotId,
          members: [
            { kind: "bot", botId: secondBotId, role: "boss" },
            { kind: "bot", botId: BOT_ID, role: "specialist" },
          ],
        },
      ],
    });
    const target = makeSnapshot({
      bots: source.bots,
      groups: makeSnapshot().groups,
    });
    const commands = commandsForPortabilityImport(
      createPortabilityArchive(source, makeSettings(), NOW),
      target,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
    ).commands;
    const bossIndex = commands.findIndex((command) => command.type === "group.boss.set");
    const memberIndex = commands.findIndex((command) => command.type.startsWith("group.member."));

    expect(bossIndex).toBeGreaterThanOrEqual(0);
    expect(memberIndex === -1 || bossIndex < memberIndex).toBe(true);
  });

  it("temporarily restores an archived bot before restoring its thread", () => {
    const archivedBot = {
      ...makeSnapshot().bots[0]!,
      groupId: null,
      archivedAt: NOW,
    };
    const source = makeSnapshot({ bots: [archivedBot], groups: [] });
    const target = makeSnapshot({ bots: [archivedBot], groups: [], threads: [] });
    const commands = commandsForPortabilityImport(
      createPortabilityArchive(source, makeSettings(), NOW),
      target,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
    ).commands;
    const restoreIndex = commands.findIndex((command) => command.type === "bot.restore");
    const threadIndex = commands.findIndex((command) => command.type === "thread.create");
    const archiveIndex = commands.findIndex((command) => command.type === "bot.archive");

    expect(restoreIndex).toBeGreaterThanOrEqual(0);
    expect(threadIndex).toBeGreaterThan(restoreIndex);
    expect(archiveIndex).toBeGreaterThan(threadIndex);
  });

  it("restores conversation history and lifecycle without starting a provider turn", () => {
    const archivedThread = { ...makeSnapshot().threads[0]!, archivedAt: NOW, pinnedAt: NOW };
    const source = makeSnapshot({ threads: [archivedThread] });
    const target = makeSnapshot({
      threads: [
        { ...archivedThread, pinnedAt: null, messages: [], proposedPlans: [], activities: [] },
      ],
    });
    const commands = commandsForPortabilityImport(
      createPortabilityArchive(source, makeSettings(), NOW),
      target,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
    ).commands;
    const restore = commands.find((command) => command.type === "thread.history.restore");

    expect(restore).toMatchObject({
      type: "thread.history.restore",
      archivedAt: NOW,
      pinnedAt: NOW,
      snoozedUntil: LATER,
    });
    expect(restore?.messages).toHaveLength(2);
    expect(restore?.proposedPlans).toHaveLength(1);
    expect(restore?.activities).toEqual([
      expect.objectContaining({ kind: "approval.history", payload: expect.any(Object) }),
    ]);
    expect(commands).not.toContainEqual(expect.objectContaining({ type: "thread.turn.start" }));
  });

  it("reports failed and partly applied records separately", () => {
    const botItem = { recordType: "bot" as const, id: BOT_ID, title: "Akeru" };
    const groupItem = { recordType: "group" as const, id: GROUP_ID, title: "Builders" };

    expect(
      summarizePortabilityApply(
        [
          { item: botItem, succeeded: true },
          { item: botItem, succeeded: false, message: "Archive step failed." },
          { item: groupItem, succeeded: false, message: "Group restore failed." },
        ],
        2,
      ),
    ).toEqual({
      applied: 0,
      skipped: 2,
      failed: 1,
      partial: 1,
      failures: [
        { ...botItem, partial: true, message: "Archive step failed." },
        { ...groupItem, partial: false, message: "Group restore failed." },
      ],
    });
  });

  it("derives the current projection only from safe records", () => {
    const records = portableRecords(makeSnapshot(), makeSettings());
    expect(records.map((record) => record.type)).toEqual([
      "bot",
      "group",
      "mcp-server",
      "mcp-server",
      "project",
      "server-settings",
      "thread",
    ]);
  });
});
