import {
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
  type PortabilityArchive,
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
        members: [{ botId: BOT_ID, role: "boss" }],
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
        proposedPlans: [],
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
  archive: PortabilityArchive,
  records: readonly PortabilityArchiveRecord[],
): PortabilityArchive {
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
      "approval-secret",
      '"sequence": 991',
      "private-branch",
      "secret-script",
      "git@github.com",
      "json-secret-value",
      "private-key-value",
      "hunter2",
      "xai-private-value",
      "~/.ssh/id_rsa",
    ]) {
      expect(text).not.toContain(excluded);
    }
    expect(text).toContain('"command": "local-tool"');
    expect(text).toContain('"serve"');
    expect(text).toContain('"--safe"');
    expect(text).toContain('"url": "https://example.com/mcp"');
    expect(text).toContain('"avatar": {\n          "kind": "dither"');
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
    expect(preview.skippedSecrets).toHaveLength(3);
    expect(preview.unsupported).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "project", count: 1 }),
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
    expect(preview.conflicts.map((entry) => entry.recordType)).toEqual(["bot", "group", "thread"]);
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

  it("conflicts a group whose member belongs to another target group", () => {
    const otherGroupId = GroupId.make("group-other");
    const snapshot = makeSnapshot({
      bots: [{ ...makeSnapshot().bots[0]!, groupId: otherGroupId }],
      groups: [
        {
          ...makeSnapshot().groups[0]!,
          id: otherGroupId,
          bossBotId: BOT_ID,
          members: [{ botId: BOT_ID, role: "boss" }],
        },
      ],
    });
    const preview = previewPortabilityImport(
      createPortabilityArchive(makeSnapshot(), makeSettings(), NOW),
      snapshot,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
    );

    expect(preview.conflicts).toContainEqual(
      expect.objectContaining({ recordType: "group", id: GROUP_ID }),
    );
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
        "thread.pin",
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

    return decideCommandSequence({ commands, readModel: target }).pipe(
      Effect.tap((events) => Effect.sync(() => expect(events.length).toBeGreaterThan(0))),
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
            { botId: secondBotId, role: "boss" },
            { botId: BOT_ID, role: "specialist" },
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

  it("unarchives a thread before changing its pin and archives it again", () => {
    const archivedThread = { ...makeSnapshot().threads[0]!, archivedAt: NOW, pinnedAt: NOW };
    const source = makeSnapshot({ threads: [archivedThread] });
    const target = makeSnapshot({
      threads: [{ ...archivedThread, pinnedAt: null }],
    });
    const commands = commandsForPortabilityImport(
      createPortabilityArchive(source, makeSettings(), NOW),
      target,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
    ).commands;
    const unarchiveIndex = commands.findIndex((command) => command.type === "thread.unarchive");
    const pinIndex = commands.findIndex((command) => command.type === "thread.pin");
    const archiveIndex = commands.findIndex((command) => command.type === "thread.archive");

    expect(unarchiveIndex).toBeGreaterThanOrEqual(0);
    expect(pinIndex).toBeGreaterThan(unarchiveIndex);
    expect(archiveIndex).toBeGreaterThan(pinIndex);
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
