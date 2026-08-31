import * as Schema from "effect/Schema";

import {
  BotId,
  EventId,
  GroupId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ThreadEnvMode } from "./environment.ts";
import { McpServerConfiguration, McpServerId } from "./mcpServer.ts";
import {
  BotAvatar,
  BotEngine,
  BotSandbox,
  BotUsageCap,
  GroupMembership,
  ModelSelection,
  OrchestrationMessageRole,
  OrchestrationProposedPlanId,
  ProviderInteractionMode,
  RuntimeMode,
} from "./orchestration.ts";
import {
  BackgroundActivityProfile,
  BackgroundActivityProfileSelection,
  ServerSettings,
} from "./settings.ts";

export const AKERU_ARCHIVE_FORMAT = "akeru.archive" as const;
export const AKERU_ARCHIVE_VERSION = 1 as const;
export const PORTABILITY_ARCHIVE_MAX_CHARS = 20 * 1024 * 1024;

const PortabilityBackgroundActivityOverrides = Schema.Struct({
  automaticGitFetchIntervalMs: Schema.optional(NonNegativeInt),
  providerHealthRefreshIntervalMs: Schema.optional(NonNegativeInt),
  hostPowerMonitorActiveIntervalMs: Schema.optional(NonNegativeInt),
  hostPowerMonitorIdleIntervalMs: Schema.optional(NonNegativeInt),
  idleClientTtlMs: Schema.optional(NonNegativeInt),
  pauseWhenHostLocked: Schema.optional(Schema.Boolean),
  pauseWhenHostLowPower: Schema.optional(Schema.Boolean),
  pauseWhenClientLowPower: Schema.optional(Schema.Boolean),
  pauseWhenOnBattery: Schema.optional(Schema.Boolean),
});

const PortabilityBackgroundActivitySettings = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  profile: BackgroundActivityProfileSelection,
  baseProfile: Schema.optional(BackgroundActivityProfile),
  overrides: PortabilityBackgroundActivityOverrides,
});

export const PortabilitySafeServerSettings = Schema.Struct({
  enableLegacyTokenStreaming: ServerSettings.fields.enableLegacyTokenStreaming,
  enableProviderUpdateChecks: ServerSettings.fields.enableProviderUpdateChecks,
  enableAgentBrowserAccess: ServerSettings.fields.enableAgentBrowserAccess,
  backgroundActivity: PortabilityBackgroundActivitySettings,
  automaticGitFetchIntervalMs: NonNegativeInt,
  providerHealthRefreshIntervalMs: NonNegativeInt,
  backgroundActivityProfile: ServerSettings.fields.backgroundActivityProfile,
  defaultThreadEnvMode: ServerSettings.fields.defaultThreadEnvMode,
  newWorktreesStartFromOrigin: ServerSettings.fields.newWorktreesStartFromOrigin,
  textGenerationModelSelection: ServerSettings.fields.textGenerationModelSelection,
  sourceControlWritingStyle: ServerSettings.fields.sourceControlWritingStyle,
  sourceControlWriterModelSelection: ServerSettings.fields.sourceControlWriterModelSelection,
});
export type PortabilitySafeServerSettings = typeof PortabilitySafeServerSettings.Type;

const ArchiveChecksum = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const ArchiveRecordBase = {
  id: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
  checksum: ArchiveChecksum,
};

export const PortabilityBotData = Schema.Struct({
  name: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  label: Schema.NullOr(TrimmedNonEmptyString),
  description: Schema.NullOr(Schema.String),
  disabledMcpServerIds: Schema.Array(McpServerId),
  avatar: BotAvatar,
  engine: Schema.NullOr(BotEngine),
  sandbox: Schema.NullOr(BotSandbox),
  runtimeMode: RuntimeMode,
  usageCap: Schema.NullOr(BotUsageCap),
  voiceEnabled: Schema.Boolean,
  archived: Schema.Boolean,
});
export type PortabilityBotData = typeof PortabilityBotData.Type;

export const PortabilityGroupData = Schema.Struct({
  name: TrimmedNonEmptyString,
  bossBotId: Schema.NullOr(BotId),
  members: Schema.Array(GroupMembership),
});
export type PortabilityGroupData = typeof PortabilityGroupData.Type;

export const PortabilityMcpServerData = Schema.Struct({
  catalogId: Schema.optional(TrimmedNonEmptyString),
  configuration: McpServerConfiguration,
});
export type PortabilityMcpServerData = typeof PortabilityMcpServerData.Type;

export const PortabilityProjectData = Schema.Struct({
  title: TrimmedNonEmptyString,
  workspaceName: TrimmedNonEmptyString,
  repository: Schema.optional(
    Schema.Struct({
      displayName: Schema.optional(TrimmedNonEmptyString),
      provider: Schema.optional(TrimmedNonEmptyString),
      owner: Schema.optional(TrimmedNonEmptyString),
      name: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
});
export type PortabilityProjectData = typeof PortabilityProjectData.Type;

export const PortabilityThreadData = Schema.Struct({
  projectId: ProjectId,
  botId: Schema.optional(Schema.NullOr(BotId)),
  groupId: Schema.optional(Schema.NullOr(GroupId)),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  createdAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])),
  settledAt: Schema.NullOr(IsoDateTime),
  snoozedUntil: Schema.NullOr(IsoDateTime),
  snoozedAt: Schema.NullOr(IsoDateTime),
  pinnedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  pinOrderKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  messages: Schema.Array(
    Schema.Struct({
      id: MessageId,
      role: OrchestrationMessageRole,
      text: Schema.String,
      respondingBotId: Schema.optional(Schema.NullOr(BotId)),
      createdAt: IsoDateTime,
      updatedAt: IsoDateTime,
    }),
  ),
  proposedPlans: Schema.Array(
    Schema.Struct({
      id: OrchestrationProposedPlanId,
      planMarkdown: TrimmedNonEmptyString,
      implementedAt: Schema.NullOr(IsoDateTime),
      implementationThreadId: Schema.NullOr(ThreadId),
      createdAt: IsoDateTime,
      updatedAt: IsoDateTime,
    }),
  ),
  approvalHistory: Schema.Array(
    Schema.Struct({
      id: EventId,
      originalKind: Schema.Literals([
        "approval.requested",
        "approval.resolved",
        "provider.approval.respond.failed",
      ]),
      summary: TrimmedNonEmptyString,
      requestId: Schema.optional(TrimmedNonEmptyString),
      requestKind: Schema.optional(TrimmedNonEmptyString),
      requestType: Schema.optional(TrimmedNonEmptyString),
      decision: Schema.optional(TrimmedNonEmptyString),
      provider: TrimmedNonEmptyString,
      createdAt: IsoDateTime,
    }),
  ),
});
export type PortabilityThreadData = typeof PortabilityThreadData.Type;

export const PortabilityArchiveRecord = Schema.Union([
  Schema.Struct({
    ...ArchiveRecordBase,
    type: Schema.Literal("server-settings"),
    id: Schema.Literal("server-settings"),
    data: PortabilitySafeServerSettings,
  }),
  Schema.Struct({
    ...ArchiveRecordBase,
    type: Schema.Literal("mcp-server"),
    data: PortabilityMcpServerData,
  }),
  Schema.Struct({
    ...ArchiveRecordBase,
    type: Schema.Literal("bot"),
    data: PortabilityBotData,
  }),
  Schema.Struct({
    ...ArchiveRecordBase,
    type: Schema.Literal("group"),
    data: PortabilityGroupData,
  }),
  Schema.Struct({
    ...ArchiveRecordBase,
    type: Schema.Literal("project"),
    data: PortabilityProjectData,
  }),
  Schema.Struct({
    ...ArchiveRecordBase,
    type: Schema.Literal("thread"),
    data: PortabilityThreadData,
  }),
]);
export type PortabilityArchiveRecord = typeof PortabilityArchiveRecord.Type;
export type PortabilityArchiveRecordType = PortabilityArchiveRecord["type"];

export const PortabilityArchive = Schema.Struct({
  format: Schema.Literal(AKERU_ARCHIVE_FORMAT),
  version: Schema.Literal(AKERU_ARCHIVE_VERSION),
  exportedAt: IsoDateTime,
  manifest: Schema.Struct({
    recordCounts: Schema.Record(TrimmedNonEmptyString, NonNegativeInt),
    excluded: Schema.Array(TrimmedNonEmptyString),
  }),
  records: Schema.Array(PortabilityArchiveRecord),
  checksum: ArchiveChecksum,
});
export type PortabilityArchive = typeof PortabilityArchive.Type;

export const PortabilityArchiveText = Schema.String.check(
  Schema.isMaxLength(PORTABILITY_ARCHIVE_MAX_CHARS),
);

export const PortabilityImportItem = Schema.Struct({
  recordType: Schema.Literals([
    "server-settings",
    "mcp-server",
    "bot",
    "group",
    "project",
    "thread",
  ]),
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
});
export type PortabilityImportItem = typeof PortabilityImportItem.Type;

export const PortabilityUnsupportedItem = Schema.Struct({
  kind: Schema.Literals([
    "project",
    "thread",
    "jobs",
    "memory",
    "routines",
    "skill-assignments",
    "usage-history",
  ]),
  count: NonNegativeInt,
  reason: TrimmedNonEmptyString,
});
export type PortabilityUnsupportedItem = typeof PortabilityUnsupportedItem.Type;

export const PortabilityImportPreview = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  stateChecksum: ArchiveChecksum,
  additions: Schema.Array(PortabilityImportItem),
  changes: Schema.Array(PortabilityImportItem),
  conflicts: Schema.Array(PortabilityImportItem),
  missingProviders: Schema.Array(TrimmedNonEmptyString),
  skippedSecrets: Schema.Array(TrimmedNonEmptyString),
  unsupported: Schema.Array(PortabilityUnsupportedItem),
});
export type PortabilityImportPreview = typeof PortabilityImportPreview.Type;

export const PortabilityExportResult = Schema.Struct({
  filename: TrimmedNonEmptyString,
  contents: PortabilityArchiveText,
});
export type PortabilityExportResult = typeof PortabilityExportResult.Type;

export const PortabilityPreviewImportInput = Schema.Struct({
  contents: PortabilityArchiveText,
});
export type PortabilityPreviewImportInput = typeof PortabilityPreviewImportInput.Type;

export const PortabilityApplyImportInput = Schema.Struct({
  contents: PortabilityArchiveText,
  expectedSnapshotSequence: NonNegativeInt,
  expectedStateChecksum: ArchiveChecksum,
});
export type PortabilityApplyImportInput = typeof PortabilityApplyImportInput.Type;

export const PortabilityApplyImportResult = Schema.Struct({
  applied: NonNegativeInt,
  skipped: NonNegativeInt,
  failed: NonNegativeInt,
  partial: NonNegativeInt,
  failures: Schema.Array(
    Schema.Struct({
      recordType: PortabilityImportItem.fields.recordType,
      id: TrimmedNonEmptyString,
      title: TrimmedNonEmptyString,
      partial: Schema.Boolean,
      message: TrimmedNonEmptyString,
    }),
  ),
});
export type PortabilityApplyImportResult = typeof PortabilityApplyImportResult.Type;

export class PortabilityArchiveError extends Schema.TaggedErrorClass<PortabilityArchiveError>()(
  "PortabilityArchiveError",
  {
    operation: Schema.Literals(["export", "preview", "apply"]),
    message: Schema.String,
  },
) {}
