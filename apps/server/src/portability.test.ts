import {
  AuthSessionId,
  DEFAULT_SERVER_SETTINGS,
  GroupId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@akeru/contracts";
import { describe, expect, it } from "vite-plus/test";
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

import {
  makeSnapshot,
  makeSettings,
  NOW,
  AVAILABLE_PROVIDER_IDS,
  resignArchive,
  BOT_ID,
  LATER,
  GROUP_ID,
  URL_MCP_ID,
} from "./portabilityTestSupport.ts";

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

  it("roundtrips sandbox browser sharing and leaves it unchanged for older archives", () => {
    const snapshot = makeSnapshot();
    const sharedSettings = { ...makeSettings(), botSandboxBrowserSharing: "shared" as const };
    const archive = createPortabilityArchive(snapshot, sharedSettings, NOW);
    const settingsRecord = archive.records.find((record) => record.type === "server-settings");
    expect(settingsRecord?.data.botSandboxBrowserSharing).toBe("shared");

    const separateSettings = { ...sharedSettings, botSandboxBrowserSharing: "separate" as const };

    const preview = previewPortabilityImport(
      archive,
      snapshot,
      separateSettings,
      AVAILABLE_PROVIDER_IDS,
    );

    expect(preview.changes).toContainEqual(
      expect.objectContaining({ recordType: "server-settings" }),
    );
    expect(
      isPortabilityPreviewCurrent(snapshot, sharedSettings, AVAILABLE_PROVIDER_IDS, preview),
    ).toBe(false);
    expect(
      commandsForPortabilityImport(archive, snapshot, separateSettings, AVAILABLE_PROVIDER_IDS)
        .settingsPatch,
    ).toEqual(expect.objectContaining({ botSandboxBrowserSharing: "shared" }));

    const legacy = resignArchive(
      archive,
      archive.records.map((record) => {
        if (record.type !== "server-settings") return record;
        const { botSandboxBrowserSharing: _sharing, ...data } = record.data;

        return { ...record, data };
      }),
    );

    const parsedLegacy = parsePortabilityArchive(JSON.stringify(legacy));
    expect(
      previewPortabilityImport(parsedLegacy, snapshot, separateSettings, AVAILABLE_PROVIDER_IDS)
        .changes,
    ).not.toContainEqual(expect.objectContaining({ recordType: "server-settings" }));
    expect(
      commandsForPortabilityImport(parsedLegacy, snapshot, separateSettings, AVAILABLE_PROVIDER_IDS)
        .settingsPatch,
    ).toBeUndefined();
    expect(
      previewPortabilityImport(parsedLegacy, snapshot, sharedSettings, AVAILABLE_PROVIDER_IDS)
        .changes,
    ).toContainEqual(expect.objectContaining({ recordType: "server-settings" }));
    expect(
      commandsForPortabilityImport(parsedLegacy, snapshot, sharedSettings, AVAILABLE_PROVIDER_IDS)
        .settingsPatch,
    ).toEqual(expect.objectContaining({ botSandboxBrowserSharing: "separate" }));
  });

  it("imports older archives whose bots still carry the retired token hard stop", () => {
    const snapshot = makeSnapshot();
    const archive = createPortabilityArchive(snapshot, makeSettings(), NOW);

    const legacy = resignArchive(
      archive,
      archive.records.map((record) =>
        record.type === "bot"
          ? { ...record, data: { ...record.data, usageCap: { unit: "tokens", limit: 50_000 } } }
          : record,
      ),
    );

    const parsed = parsePortabilityArchive(JSON.stringify(legacy));

    const commands = commandsForPortabilityImport(
      parsed,
      makeSnapshot(),
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
    );

    expect(JSON.stringify(commands)).not.toContain("usageCap");
    expect(
      parsed.records.some((record) => record.type === "bot" && "usageCap" in record.data),
    ).toBe(false);
    expect(
      previewPortabilityImport(parsed, makeSnapshot(), makeSettings(), AVAILABLE_PROVIDER_IDS)
        .changes,
    ).toEqual(
      previewPortabilityImport(archive, makeSnapshot(), makeSettings(), AVAILABLE_PROVIDER_IDS)
        .changes,
    );
    expect(
      archive.records.some((record) => record.type === "bot" && "usageCap" in record.data),
    ).toBe(false);
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
          ? // SAFETY: This deliberately invalid record tests rejection of paired identities.
            ({
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
            } as never)
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
  it("previews additions, conflicts, missing providers, and excluded data", () => {
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
    expect(preview.unsupported).toEqual([]);
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
