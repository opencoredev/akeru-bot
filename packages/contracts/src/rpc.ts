import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import {
  ComputerTarget,
  ComputerSessionInput,
  ComputerInput,
  ComputerState,
  ComputerSession,
  ComputerEvent,
  ComputerError,
} from "./computer.ts";

import { AkeruBotUsageInput, AkeruBotUsageReadError, AkeruBotUsageSnapshot } from "./akeruUsage.ts";
import {
  AkeruMemoryOperationError,
  AkeruMemoryArchiveV2,
  AkeruMemoryExportInput,
  AkeruMemoryImportPreviewInput,
  AkeruMemoryImportPreview,
  AkeruMemoryImportApplyInput,
  AkeruMemoryImportApplyResult,
  AkeruMemoryFactsListInput,
  AkeruMemoryFactsListResult,
  AkeruMemoryMutateInput,
  AkeruMemoryMutationResult,
  AkeruMemoryDocumentsInspectInput,
  AkeruMemoryDocumentsSnapshot,
  AkeruMemoryDocumentReplaceInput,
  AkeruMemoryDocument,
  AkeruMemoryObservationsClearInput,
  AkeruMarkdownMemoryArchiveV3,
  AkeruMarkdownMemoryExportInput,
  AkeruMarkdownMemoryImportApplyInput,
  AkeruMarkdownMemoryImportApplyResult,
  AkeruMarkdownMemoryImportPreview,
  AkeruMarkdownMemoryImportPreviewInput,
} from "./akeruMemory.ts";

import { ExternalLauncherError, LaunchEditorInput } from "./editor.ts";
import {
  AuthAccessStreamError,
  AuthAccessStreamEvent,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import {
  BackgroundPolicySnapshot,
  ClientActivityReportInput,
  HostPowerSnapshot,
} from "./background.ts";
import {
  AssetAccessError,
  AssetCreateUrlInput,
  AssetCreateUrlResult,
  AttachmentCreateUploadUrlInput,
  AttachmentCreateUploadUrlResult,
  AttachmentDeleteInput,
  AttachmentNotFoundError,
  AttachmentRevealInput,
  AttachmentUploadSigningKeyError,
} from "./assets.ts";
import { KeybindingsConfigError } from "./keybindings.ts";
import {
  ClientOrchestrationCommand,
  ORCHESTRATION_WS_METHODS,
  OrchestrationDispatchCommandError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetSnapshotError,
  OrchestrationSearchThreadsError,
  OrchestrationSearchThreadsInput,
  OrchestrationGetTurnDiffError,
  OrchestrationGetTurnDiffInput,
  OrchestrationRpcSchemas,
  OrchestrationGetWorkflowScriptError,
} from "./orchestration.ts";
import {
  ProviderUploadFeedbackError,
  ProviderUploadFeedbackInput,
  ProviderUploadFeedbackResult,
} from "./provider.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  ProjectListEntriesError,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectReadFileError,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectSearchEntriesError,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileError,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project.ts";
import {
  DiscoveredLocalServerList,
  ConfiguredLocalServerUrls,
  PreviewCloseInput,
  PreviewError,
  PreviewEvent,
  PreviewEventsSubscribeInput,
  PreviewListInput,
  PreviewListResult,
  PreviewNavigateInput,
  PreviewOpenInput,
  PreviewRefreshInput,
  PreviewReportStatusInput,
  PreviewResizeInput,
  PreviewSessionSnapshot,
} from "./preview.ts";
import {
  PreviewAutomationError,
  PreviewAutomationHost,
  PreviewAutomationHostFocus,
  PreviewAutomationResponse,
  PreviewAutomationStreamEvent,
} from "./previewAutomation.ts";
import {
  ServerConfigStreamEvent,
  ServerConfig,
  ServerProviderUpdateError,
  ServerProviderUpdateInput,
  ServerLifecycleStreamEvent,
  ServerRemoveKeybindingInput,
  ServerRemoveKeybindingResult,
  ServerProviderUpdatedPayload,
  ServerSelfUpdateError,
  ServerSelfUpdateInput,
  ServerSelfUpdateProgressEvent,
  ServerSelfUpdateResult,
  ServerTraceDiagnosticsResult,
  ServerProcessDiagnosticsResult,
  ServerProcessResourceHistoryInput,
  ServerProcessResourceHistoryResult,
  ServerSignalProcessInput,
  ServerSignalProcessResult,
  ServerUpsertKeybindingInput,
  ServerUpsertKeybindingResult,
} from "./server.ts";
import {
  ResourceTelemetryHistory,
  ResourceTelemetryHistoryInput,
  ResourceTelemetryRetryResult,
  ResourceTelemetrySnapshot,
} from "./resourceTelemetry.ts";
import { UsageReadError, UsageSummary, UsageSummaryInput } from "./usage.ts";
import {
  RemoteDoctorError,
  RemoteDoctorRepairInput,
  RemoteDoctorStatus,
} from "./remoteDiagnostics.ts";
import { ServerSettings, ServerSettingsError, ServerSettingsRpcPatch } from "./settings.ts";
import {
  BotInboxItem,
  BotInboxResolveInput,
  McpServerAuthenticateInput,
  McpServerAuthenticationError,
  McpServerAuthenticationProgress,
  SubscriptionAuthCompleteInput,
  SubscriptionAuthError,
  SubscriptionAuthHealthTestInput,
  SubscriptionAuthLoginProgress,
  SubscriptionAuthLogoutInput,
  SubscriptionAuthPollInput,
  SubscriptionAuthStartInput,
  SubscriptionAuthStartResult,
  SubscriptionAuthStatuses,
} from "./subscriptionAuth.ts";
import {
  ImageGenerationError,
  ImageProviderHealthTestInput,
  ImageProviderListResult,
} from "./imageGeneration.ts";
import {
  VoiceCallError,
  VoiceCallHangupInput,
  VoiceCallSnapshot,
  VoiceCallStartInput,
  VoiceCallStartResult,
  VoiceProviderInput,
  VoiceConnectInput,
  VoiceProviderStatus,
  VoiceProvidersResult,
  VoiceListVoicesInput,
  VoiceListVoicesResult,
  VoiceTranscribeInput,
  VoiceTranscribeResult,
  VoiceSynthesizeInput,
  VoiceSynthesizeResult,
  VoiceCancelInput,
  VoiceCancelResult,
} from "./voiceCall.ts";
import {
  PortabilityApplyImportInput,
  PortabilityApplyImportResult,
  PortabilityArchiveError,
  PortabilityExportResult,
  PortabilityImportPreview,
  PortabilityPreviewImportInput,
} from "./portability.ts";
import {
  RoutineListRunsInput,
  RoutineListRunsResult,
  RoutineListThreadRunsResult,
  RoutineListThreadRunsInput,
  RoutineReadError,
  RoutineThreadReadError,
} from "./routines.ts";
import {
  ComposioAuthorizeInput,
  ComposioAuthorizeResult,
  ComposioConfigureInput,
  ComposioDisconnectInput,
  ComposioOperationError,
  ComposioStatus,
  ComposioToolkit,
  ComposioToolkitSearchInput,
} from "./composio.ts";

export const WS_METHODS = {
  // Project registry methods
  projectsList: "projects.list",
  projectsListEntries: "projects.listEntries",
  projectsReadFile: "projects.readFile",
  projectsSearchEntries: "projects.searchEntries",
  projectsWriteFile: "projects.writeFile",

  // Shell methods
  shellOpenInEditor: "shell.openInEditor",
  shellRevealAttachment: "shell.revealAttachment",

  // Filesystem methods
  assetsCreateUrl: "assets.createUrl",
  attachmentsCreateUploadUrl: "attachments.createUploadUrl",
  attachmentsDelete: "attachments.delete",

  // Provider methods
  providerUploadFeedback: "provider.uploadFeedback",

  computerGetState: "computer.getState",
  computerOpen: "computer.open",
  computerAcquire: "computer.acquire",
  computerInput: "computer.input",
  computerRelease: "computer.release",
  computerClose: "computer.close",
  computerStop: "computer.stop",
  computerEvents: "computer.events",

  // Preview methods
  previewOpen: "preview.open",
  previewNavigate: "preview.navigate",
  previewResize: "preview.resize",
  previewRefresh: "preview.refresh",
  previewClose: "preview.close",
  previewList: "preview.list",
  previewReportStatus: "preview.reportStatus",
  previewAutomationConnect: "previewAutomation.connect",
  previewAutomationRespond: "previewAutomation.respond",
  previewAutomationFocusHost: "previewAutomation.focusHost",

  // Server meta
  serverProbe: "server.probe",
  serverGetConfig: "server.getConfig",
  serverRefreshProviders: "server.refreshProviders",
  serverUpdateProvider: "server.updateProvider",
  serverUpdateServer: "server.updateServer",
  serverUpdateServerWithProgress: "server.updateServerWithProgress",
  serverUpsertKeybinding: "server.upsertKeybinding",
  serverRemoveKeybinding: "server.removeKeybinding",
  serverGetSettings: "server.getSettings",
  serverUpdateSettings: "server.updateSettings",
  composioGetStatus: "composio.getStatus",
  composioConfigure: "composio.configure",
  composioRemove: "composio.remove",
  composioSearchToolkits: "composio.searchToolkits",
  composioAuthorize: "composio.authorize",
  composioDisconnect: "composio.disconnect",
  subscriptionAuthList: "subscriptionAuth.list",
  subscriptionAuthStart: "subscriptionAuth.start",
  subscriptionAuthPoll: "subscriptionAuth.poll",
  subscriptionAuthComplete: "subscriptionAuth.complete",
  subscriptionAuthCancel: "subscriptionAuth.cancel",
  subscriptionAuthLogout: "subscriptionAuth.logout",
  subscriptionAuthHealthTest: "subscriptionAuth.healthTest",

  // Image generation providers
  imageProviderList: "imageProvider.list",
  imageProviderHealthTest: "imageProvider.healthTest",
  mcpServerAuthenticate: "mcpServer.authenticate",
  botInboxList: "botInbox.list",
  botInboxResolve: "botInbox.resolve",
  voiceProviders: "voice.providers",
  voiceConnect: "voice.connect",
  voiceDisconnect: "voice.disconnect",
  voiceTest: "voice.test",
  voiceListVoices: "voice.listVoices",
  voiceTranscribe: "voice.transcribe",
  voiceSynthesize: "voice.synthesize",
  voiceCancel: "voice.cancel",
  voiceCallGet: "voiceCall.get",
  voiceCallStart: "voiceCall.start",
  voiceCallHangup: "voiceCall.hangup",
  serverGetTraceDiagnostics: "server.getTraceDiagnostics",
  serverGetProcessDiagnostics: "server.getProcessDiagnostics",
  serverGetProcessResourceHistory: "server.getProcessResourceHistory",
  serverGetResourceTelemetryHistory: "server.getResourceTelemetryHistory",
  serverRetryResourceTelemetry: "server.retryResourceTelemetry",
  serverSignalProcess: "server.signalProcess",
  serverReportClientActivity: "server.reportClientActivity",
  serverReportHostPowerState: "server.reportHostPowerState",
  serverGetBackgroundPolicy: "server.getBackgroundPolicy",
  serverGetUsageSummary: "server.getUsageSummary",
  serverGetRemoteDoctor: "server.getRemoteDoctor",
  serverRepairRemoteDoctor: "server.repairRemoteDoctor",
  memoryExport: "memory.documents.export",
  memoryImportPreview: "memory.documents.importPreview",
  memoryImportApply: "memory.documents.importApply",
  memoryArchiveExport: "memory.archive.export",
  memoryArchivePreviewImport: "memory.archive.previewImport",
  memoryArchiveApplyImport: "memory.archive.applyImport",
  memoryFactsList: "memory.facts.list",
  memoryFactMutate: "memory.facts.mutate",
  memoryDocumentsInspect: "memory.documents.inspect",
  memoryDocumentReplace: "memory.document.replace",
  memoryObservationsClear: "memory.observations.clear",
  botUsage: "bot.usage",
  portabilityExport: "portability.export",
  portabilityPreviewImport: "portability.previewImport",
  portabilityApplyImport: "portability.applyImport",
  routinesListRuns: "routines.listRuns",
  routinesListThreadRuns: "routines.listThreadRuns",

  // Streaming subscriptions
  subscribePreviewEvents: "subscribePreviewEvents",
  subscribeDiscoveredLocalServers: "subscribeDiscoveredLocalServers",
  subscribeServerConfig: "subscribeServerConfig",
  subscribeServerLifecycle: "subscribeServerLifecycle",
  subscribeAuthAccess: "subscribeAuthAccess",
  subscribeBackgroundPolicy: "subscribeBackgroundPolicy",
  subscribeResourceTelemetry: "subscribeResourceTelemetry",
} as const;

export const WsServerUpsertKeybindingRpc = Rpc.make(WS_METHODS.serverUpsertKeybinding, {
  payload: ServerUpsertKeybindingInput,
  success: ServerUpsertKeybindingResult,
  error: Schema.Union([KeybindingsConfigError, EnvironmentAuthorizationError]),
});

export const WsServerRemoveKeybindingRpc = Rpc.make(WS_METHODS.serverRemoveKeybinding, {
  payload: ServerRemoveKeybindingInput,
  success: ServerRemoveKeybindingResult,
  error: Schema.Union([KeybindingsConfigError, EnvironmentAuthorizationError]),
});

export const WsServerProbeRpc = Rpc.make(WS_METHODS.serverProbe, {
  payload: Schema.Struct({}),
  success: Schema.Struct({}),
  error: EnvironmentAuthorizationError,
});

export const WsServerGetConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: Schema.Struct({}),
  success: ServerConfig,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError, EnvironmentAuthorizationError]),
});

export const WsServerRefreshProvidersRpc = Rpc.make(WS_METHODS.serverRefreshProviders, {
  payload: Schema.Struct({
    /**
     * When supplied, only refresh this specific provider instance. When
     * omitted, refresh all configured instances — the legacy `refresh()`
     * behaviour retained for transports that still dispatch untargeted
     * refreshes.
     */
    instanceId: Schema.optional(ProviderInstanceId),
  }),
  success: ServerProviderUpdatedPayload,
  error: EnvironmentAuthorizationError,
});

export const WsServerUpdateProviderRpc = Rpc.make(WS_METHODS.serverUpdateProvider, {
  payload: ServerProviderUpdateInput,
  success: ServerProviderUpdatedPayload,
  error: Schema.Union([ServerProviderUpdateError, EnvironmentAuthorizationError]),
});

export const WsServerUpdateServerRpc = Rpc.make(WS_METHODS.serverUpdateServer, {
  payload: ServerSelfUpdateInput,
  success: ServerSelfUpdateResult,
  error: Schema.Union([ServerSelfUpdateError, EnvironmentAuthorizationError]),
});

export const WsServerUpdateServerWithProgressRpc = Rpc.make(
  WS_METHODS.serverUpdateServerWithProgress,
  {
    payload: ServerSelfUpdateInput,
    success: ServerSelfUpdateProgressEvent,
    error: Schema.Union([ServerSelfUpdateError, EnvironmentAuthorizationError]),
    stream: true,
  },
);

export const WsServerGetSettingsRpc = Rpc.make(WS_METHODS.serverGetSettings, {
  payload: Schema.Struct({}),
  success: ServerSettings,
  error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
});

export const WsServerUpdateSettingsRpc = Rpc.make(WS_METHODS.serverUpdateSettings, {
  payload: Schema.Struct({ patch: ServerSettingsRpcPatch }),
  success: ServerSettings,
  error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
});

export const WsComposioGetStatusRpc = Rpc.make(WS_METHODS.composioGetStatus, {
  payload: Schema.Struct({}),
  success: ComposioStatus,
  error: Schema.Union([ComposioOperationError, EnvironmentAuthorizationError]),
});

export const WsComposioConfigureRpc = Rpc.make(WS_METHODS.composioConfigure, {
  payload: ComposioConfigureInput,
  success: ComposioStatus,
  error: Schema.Union([ComposioOperationError, EnvironmentAuthorizationError]),
});

export const WsComposioRemoveRpc = Rpc.make(WS_METHODS.composioRemove, {
  payload: Schema.Struct({}),
  success: ComposioStatus,
  error: Schema.Union([ComposioOperationError, EnvironmentAuthorizationError]),
});

export const WsComposioSearchToolkitsRpc = Rpc.make(WS_METHODS.composioSearchToolkits, {
  payload: ComposioToolkitSearchInput,
  success: Schema.Array(ComposioToolkit),
  error: Schema.Union([ComposioOperationError, EnvironmentAuthorizationError]),
});

export const WsComposioAuthorizeRpc = Rpc.make(WS_METHODS.composioAuthorize, {
  payload: ComposioAuthorizeInput,
  success: ComposioAuthorizeResult,
  error: Schema.Union([ComposioOperationError, EnvironmentAuthorizationError]),
});

export const WsComposioDisconnectRpc = Rpc.make(WS_METHODS.composioDisconnect, {
  payload: ComposioDisconnectInput,
  success: ComposioStatus,
  error: Schema.Union([ComposioOperationError, EnvironmentAuthorizationError]),
});

export const WsSubscriptionAuthListRpc = Rpc.make(WS_METHODS.subscriptionAuthList, {
  payload: Schema.Struct({}),
  success: SubscriptionAuthStatuses,
  error: Schema.Union([SubscriptionAuthError, EnvironmentAuthorizationError]),
});

export const WsSubscriptionAuthStartRpc = Rpc.make(WS_METHODS.subscriptionAuthStart, {
  payload: SubscriptionAuthStartInput,
  success: SubscriptionAuthStartResult,
  error: Schema.Union([SubscriptionAuthError, EnvironmentAuthorizationError]),
});

export const WsSubscriptionAuthPollRpc = Rpc.make(WS_METHODS.subscriptionAuthPoll, {
  payload: SubscriptionAuthPollInput,
  success: SubscriptionAuthLoginProgress,
  error: Schema.Union([SubscriptionAuthError, EnvironmentAuthorizationError]),
});

export const WsSubscriptionAuthCompleteRpc = Rpc.make(WS_METHODS.subscriptionAuthComplete, {
  payload: SubscriptionAuthCompleteInput,
  success: SubscriptionAuthLoginProgress,
  error: Schema.Union([SubscriptionAuthError, EnvironmentAuthorizationError]),
});

export const WsSubscriptionAuthCancelRpc = Rpc.make(WS_METHODS.subscriptionAuthCancel, {
  payload: SubscriptionAuthPollInput,
  success: Schema.Struct({}),
  error: Schema.Union([SubscriptionAuthError, EnvironmentAuthorizationError]),
});

export const WsSubscriptionAuthLogoutRpc = Rpc.make(WS_METHODS.subscriptionAuthLogout, {
  payload: SubscriptionAuthLogoutInput,
  success: SubscriptionAuthStatuses,
  error: Schema.Union([SubscriptionAuthError, EnvironmentAuthorizationError]),
});

export const WsSubscriptionAuthHealthTestRpc = Rpc.make(WS_METHODS.subscriptionAuthHealthTest, {
  payload: SubscriptionAuthHealthTestInput,
  success: SubscriptionAuthStatuses,
  error: Schema.Union([SubscriptionAuthError, EnvironmentAuthorizationError]),
});

export const WsImageProviderListRpc = Rpc.make(WS_METHODS.imageProviderList, {
  payload: Schema.Struct({}),
  success: ImageProviderListResult,
  error: Schema.Union([ImageGenerationError, EnvironmentAuthorizationError]),
});

export const WsImageProviderHealthTestRpc = Rpc.make(WS_METHODS.imageProviderHealthTest, {
  payload: ImageProviderHealthTestInput,
  success: ImageProviderListResult,
  error: Schema.Union([ImageGenerationError, EnvironmentAuthorizationError]),
});

export const WsMcpServerAuthenticateRpc = Rpc.make(WS_METHODS.mcpServerAuthenticate, {
  payload: McpServerAuthenticateInput,
  success: McpServerAuthenticationProgress,
  error: Schema.Union([McpServerAuthenticationError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsBotInboxListRpc = Rpc.make(WS_METHODS.botInboxList, {
  payload: Schema.Struct({}),
  success: Schema.Array(BotInboxItem),
  error: Schema.Union([SubscriptionAuthError, EnvironmentAuthorizationError]),
});

export const WsBotInboxResolveRpc = Rpc.make(WS_METHODS.botInboxResolve, {
  payload: BotInboxResolveInput,
  success: Schema.Void,
  error: Schema.Union([SubscriptionAuthError, EnvironmentAuthorizationError]),
});

const VoiceRpcError = Schema.Union([VoiceCallError, EnvironmentAuthorizationError]);
export const WsVoiceProvidersRpc = Rpc.make(WS_METHODS.voiceProviders, {
  payload: Schema.Struct({}),
  success: VoiceProvidersResult,
  error: VoiceRpcError,
});
export const WsVoiceConnectRpc = Rpc.make(WS_METHODS.voiceConnect, {
  payload: VoiceConnectInput,
  success: VoiceProviderStatus,
  error: VoiceRpcError,
});
export const WsVoiceDisconnectRpc = Rpc.make(WS_METHODS.voiceDisconnect, {
  payload: VoiceProviderInput,
  success: VoiceProviderStatus,
  error: VoiceRpcError,
});
export const WsVoiceTestRpc = Rpc.make(WS_METHODS.voiceTest, {
  payload: VoiceProviderInput,
  success: VoiceProviderStatus,
  error: VoiceRpcError,
});
export const WsVoiceListVoicesRpc = Rpc.make(WS_METHODS.voiceListVoices, {
  payload: VoiceListVoicesInput,
  success: VoiceListVoicesResult,
  error: VoiceRpcError,
});
export const WsVoiceTranscribeRpc = Rpc.make(WS_METHODS.voiceTranscribe, {
  payload: VoiceTranscribeInput,
  success: VoiceTranscribeResult,
  error: VoiceRpcError,
});
export const WsVoiceSynthesizeRpc = Rpc.make(WS_METHODS.voiceSynthesize, {
  payload: VoiceSynthesizeInput,
  success: VoiceSynthesizeResult,
  error: VoiceRpcError,
});
export const WsVoiceCancelRpc = Rpc.make(WS_METHODS.voiceCancel, {
  payload: VoiceCancelInput,
  success: VoiceCancelResult,
  error: VoiceRpcError,
});

export const WsVoiceCallGetRpc = Rpc.make(WS_METHODS.voiceCallGet, {
  payload: Schema.Struct({}),
  success: VoiceCallSnapshot,
  error: EnvironmentAuthorizationError,
});

export const WsVoiceCallStartRpc = Rpc.make(WS_METHODS.voiceCallStart, {
  payload: VoiceCallStartInput,
  success: VoiceCallStartResult,
  error: Schema.Union([VoiceCallError, EnvironmentAuthorizationError]),
});

export const WsVoiceCallHangupRpc = Rpc.make(WS_METHODS.voiceCallHangup, {
  payload: VoiceCallHangupInput,
  success: VoiceCallSnapshot,
  error: Schema.Union([VoiceCallError, EnvironmentAuthorizationError]),
});

export const WsServerGetTraceDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetTraceDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerTraceDiagnosticsResult,
  error: EnvironmentAuthorizationError,
});

export const WsServerGetProcessDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetProcessDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerProcessDiagnosticsResult,
  error: EnvironmentAuthorizationError,
});

export const WsServerGetProcessResourceHistoryRpc = Rpc.make(
  WS_METHODS.serverGetProcessResourceHistory,
  {
    payload: ServerProcessResourceHistoryInput,
    success: ServerProcessResourceHistoryResult,
    error: EnvironmentAuthorizationError,
  },
);

export const WsServerGetResourceTelemetryHistoryRpc = Rpc.make(
  WS_METHODS.serverGetResourceTelemetryHistory,
  {
    payload: ResourceTelemetryHistoryInput,
    success: ResourceTelemetryHistory,
    error: EnvironmentAuthorizationError,
  },
);

export const WsServerRetryResourceTelemetryRpc = Rpc.make(WS_METHODS.serverRetryResourceTelemetry, {
  payload: Schema.Struct({}),
  success: ResourceTelemetryRetryResult,
  error: EnvironmentAuthorizationError,
});

export const WsServerGetUsageSummaryRpc = Rpc.make(WS_METHODS.serverGetUsageSummary, {
  payload: UsageSummaryInput,
  success: UsageSummary,
  error: Schema.Union([EnvironmentAuthorizationError, UsageReadError]),
});

export const WsServerGetRemoteDoctorRpc = Rpc.make(WS_METHODS.serverGetRemoteDoctor, {
  payload: Schema.Struct({}),
  success: RemoteDoctorStatus,
  error: Schema.Union([EnvironmentAuthorizationError, RemoteDoctorError]),
});

export const WsServerRepairRemoteDoctorRpc = Rpc.make(WS_METHODS.serverRepairRemoteDoctor, {
  payload: RemoteDoctorRepairInput,
  success: RemoteDoctorStatus,
  error: Schema.Union([EnvironmentAuthorizationError, RemoteDoctorError]),
});

export const WsServerSignalProcessRpc = Rpc.make(WS_METHODS.serverSignalProcess, {
  payload: ServerSignalProcessInput,
  success: ServerSignalProcessResult,
  error: EnvironmentAuthorizationError,
});

export const WsServerReportClientActivityRpc = Rpc.make(WS_METHODS.serverReportClientActivity, {
  payload: ClientActivityReportInput,
  error: EnvironmentAuthorizationError,
});

export const WsServerReportHostPowerStateRpc = Rpc.make(WS_METHODS.serverReportHostPowerState, {
  payload: HostPowerSnapshot,
  error: EnvironmentAuthorizationError,
});

export const WsServerGetBackgroundPolicyRpc = Rpc.make(WS_METHODS.serverGetBackgroundPolicy, {
  payload: Schema.Struct({}),
  success: BackgroundPolicySnapshot,
  error: EnvironmentAuthorizationError,
});

export const WsMemoryExportRpc = Rpc.make(WS_METHODS.memoryExport, {
  payload: AkeruMarkdownMemoryExportInput,
  success: AkeruMarkdownMemoryArchiveV3,
  error: Schema.Union([AkeruMemoryOperationError, EnvironmentAuthorizationError]),
});

export const WsMemoryImportPreviewRpc = Rpc.make(WS_METHODS.memoryImportPreview, {
  payload: AkeruMarkdownMemoryImportPreviewInput,
  success: AkeruMarkdownMemoryImportPreview,
  error: Schema.Union([AkeruMemoryOperationError, EnvironmentAuthorizationError]),
});

export const WsMemoryImportApplyRpc = Rpc.make(WS_METHODS.memoryImportApply, {
  payload: AkeruMarkdownMemoryImportApplyInput,
  success: AkeruMarkdownMemoryImportApplyResult,
  error: Schema.Union([AkeruMemoryOperationError, EnvironmentAuthorizationError]),
});

export const WsMemoryArchiveExportRpc = Rpc.make(WS_METHODS.memoryArchiveExport, {
  payload: AkeruMemoryExportInput,
  success: AkeruMemoryArchiveV2,
  error: Schema.Union([AkeruMemoryOperationError, EnvironmentAuthorizationError]),
});

export const WsMemoryArchivePreviewImportRpc = Rpc.make(WS_METHODS.memoryArchivePreviewImport, {
  payload: AkeruMemoryImportPreviewInput,
  success: AkeruMemoryImportPreview,
  error: Schema.Union([AkeruMemoryOperationError, EnvironmentAuthorizationError]),
});

export const WsMemoryArchiveApplyImportRpc = Rpc.make(WS_METHODS.memoryArchiveApplyImport, {
  payload: AkeruMemoryImportApplyInput,
  success: AkeruMemoryImportApplyResult,
  error: Schema.Union([AkeruMemoryOperationError, EnvironmentAuthorizationError]),
});

export const WsMemoryFactsListRpc = Rpc.make(WS_METHODS.memoryFactsList, {
  payload: AkeruMemoryFactsListInput,
  success: AkeruMemoryFactsListResult,
  error: Schema.Union([AkeruMemoryOperationError, EnvironmentAuthorizationError]),
});

export const WsMemoryFactMutateRpc = Rpc.make(WS_METHODS.memoryFactMutate, {
  payload: AkeruMemoryMutateInput,
  success: AkeruMemoryMutationResult,
  error: Schema.Union([AkeruMemoryOperationError, EnvironmentAuthorizationError]),
});

export const WsMemoryDocumentsInspectRpc = Rpc.make(WS_METHODS.memoryDocumentsInspect, {
  payload: AkeruMemoryDocumentsInspectInput,
  success: AkeruMemoryDocumentsSnapshot,
  error: Schema.Union([AkeruMemoryOperationError, EnvironmentAuthorizationError]),
});

export const WsMemoryDocumentReplaceRpc = Rpc.make(WS_METHODS.memoryDocumentReplace, {
  payload: AkeruMemoryDocumentReplaceInput,
  success: AkeruMemoryDocument,
  error: Schema.Union([AkeruMemoryOperationError, EnvironmentAuthorizationError]),
});

export const WsMemoryObservationsClearRpc = Rpc.make(WS_METHODS.memoryObservationsClear, {
  payload: AkeruMemoryObservationsClearInput,
  error: Schema.Union([AkeruMemoryOperationError, EnvironmentAuthorizationError]),
});

export const WsBotUsageRpc = Rpc.make(WS_METHODS.botUsage, {
  payload: AkeruBotUsageInput,
  success: AkeruBotUsageSnapshot,
  error: Schema.Union([AkeruBotUsageReadError, EnvironmentAuthorizationError]),
});

export const WsPortabilityExportRpc = Rpc.make(WS_METHODS.portabilityExport, {
  payload: Schema.Struct({}),
  success: PortabilityExportResult,
  error: Schema.Union([PortabilityArchiveError, EnvironmentAuthorizationError]),
});

export const WsPortabilityPreviewImportRpc = Rpc.make(WS_METHODS.portabilityPreviewImport, {
  payload: PortabilityPreviewImportInput,
  success: PortabilityImportPreview,
  error: Schema.Union([PortabilityArchiveError, EnvironmentAuthorizationError]),
});

export const WsPortabilityApplyImportRpc = Rpc.make(WS_METHODS.portabilityApplyImport, {
  payload: PortabilityApplyImportInput,
  success: PortabilityApplyImportResult,
  error: Schema.Union([PortabilityArchiveError, EnvironmentAuthorizationError]),
});

export const WsRoutinesListRunsRpc = Rpc.make(WS_METHODS.routinesListRuns, {
  payload: RoutineListRunsInput,
  success: RoutineListRunsResult,
  error: Schema.Union([RoutineReadError, EnvironmentAuthorizationError]),
});

export const WsRoutinesListThreadRunsRpc = Rpc.make(WS_METHODS.routinesListThreadRuns, {
  payload: RoutineListThreadRunsInput,
  success: RoutineListThreadRunsResult,
  error: Schema.Union([RoutineThreadReadError, EnvironmentAuthorizationError]),
});

export const WsProjectsSearchEntriesRpc = Rpc.make(WS_METHODS.projectsSearchEntries, {
  payload: ProjectSearchEntriesInput,
  success: ProjectSearchEntriesResult,
  error: Schema.Union([ProjectSearchEntriesError, EnvironmentAuthorizationError]),
});

export const WsProjectsListEntriesRpc = Rpc.make(WS_METHODS.projectsListEntries, {
  payload: ProjectListEntriesInput,
  success: ProjectListEntriesResult,
  error: Schema.Union([ProjectListEntriesError, EnvironmentAuthorizationError]),
});

export const WsProjectsReadFileRpc = Rpc.make(WS_METHODS.projectsReadFile, {
  payload: ProjectReadFileInput,
  success: ProjectReadFileResult,
  error: Schema.Union([ProjectReadFileError, EnvironmentAuthorizationError]),
});

export const WsProjectsWriteFileRpc = Rpc.make(WS_METHODS.projectsWriteFile, {
  payload: ProjectWriteFileInput,
  success: ProjectWriteFileResult,
  error: Schema.Union([ProjectWriteFileError, EnvironmentAuthorizationError]),
});

export const WsShellOpenInEditorRpc = Rpc.make(WS_METHODS.shellOpenInEditor, {
  payload: LaunchEditorInput,
  error: Schema.Union([ExternalLauncherError, EnvironmentAuthorizationError]),
});

export const WsShellRevealAttachmentRpc = Rpc.make(WS_METHODS.shellRevealAttachment, {
  payload: AttachmentRevealInput,
  error: Schema.Union([
    AttachmentNotFoundError,
    ExternalLauncherError,
    EnvironmentAuthorizationError,
  ]),
});

export const WsAssetsCreateUrlRpc = Rpc.make(WS_METHODS.assetsCreateUrl, {
  payload: AssetCreateUrlInput,
  success: AssetCreateUrlResult,
  error: Schema.Union([AssetAccessError, EnvironmentAuthorizationError]),
});

export const WsAttachmentsCreateUploadUrlRpc = Rpc.make(WS_METHODS.attachmentsCreateUploadUrl, {
  payload: AttachmentCreateUploadUrlInput,
  success: AttachmentCreateUploadUrlResult,
  error: Schema.Union([AttachmentUploadSigningKeyError, EnvironmentAuthorizationError]),
});

export const WsAttachmentsDeleteRpc = Rpc.make(WS_METHODS.attachmentsDelete, {
  payload: AttachmentDeleteInput,
  error: EnvironmentAuthorizationError,
});

export const WsProviderUploadFeedbackRpc = Rpc.make(WS_METHODS.providerUploadFeedback, {
  payload: ProviderUploadFeedbackInput,
  success: ProviderUploadFeedbackResult,
  error: Schema.Union([ProviderUploadFeedbackError, EnvironmentAuthorizationError]),
});

const computerError = Schema.Union([ComputerError, EnvironmentAuthorizationError]);
export const WsComputerGetStateRpc = Rpc.make(WS_METHODS.computerGetState, {
  payload: ComputerTarget,
  success: ComputerState,
  error: computerError,
});
export const WsComputerOpenRpc = Rpc.make(WS_METHODS.computerOpen, {
  payload: ComputerTarget,
  success: ComputerState,
  error: computerError,
});
export const WsComputerAcquireRpc = Rpc.make(WS_METHODS.computerAcquire, {
  payload: ComputerTarget,
  success: ComputerSession,
  error: computerError,
});
export const WsComputerInputRpc = Rpc.make(WS_METHODS.computerInput, {
  payload: ComputerInput,
  success: Schema.Void,
  error: computerError,
});
export const WsComputerReleaseRpc = Rpc.make(WS_METHODS.computerRelease, {
  payload: ComputerSessionInput,
  success: ComputerState,
  error: computerError,
});
export const WsComputerCloseRpc = Rpc.make(WS_METHODS.computerClose, {
  payload: ComputerTarget,
  success: ComputerState,
  error: computerError,
});
export const WsComputerStopRpc = Rpc.make(WS_METHODS.computerStop, {
  payload: ComputerTarget,
  success: ComputerState,
  error: computerError,
});
export const WsComputerEventsRpc = Rpc.make(WS_METHODS.computerEvents, {
  payload: ComputerTarget,
  success: ComputerEvent,
  error: computerError,
  stream: true,
});

export const WsPreviewOpenRpc = Rpc.make(WS_METHODS.previewOpen, {
  payload: PreviewOpenInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewNavigateRpc = Rpc.make(WS_METHODS.previewNavigate, {
  payload: PreviewNavigateInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewResizeRpc = Rpc.make(WS_METHODS.previewResize, {
  payload: PreviewResizeInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewRefreshRpc = Rpc.make(WS_METHODS.previewRefresh, {
  payload: PreviewRefreshInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewCloseRpc = Rpc.make(WS_METHODS.previewClose, {
  payload: PreviewCloseInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewListRpc = Rpc.make(WS_METHODS.previewList, {
  payload: PreviewListInput,
  success: PreviewListResult,
  error: EnvironmentAuthorizationError,
});

export const WsPreviewReportStatusRpc = Rpc.make(WS_METHODS.previewReportStatus, {
  payload: PreviewReportStatusInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewAutomationConnectRpc = Rpc.make(WS_METHODS.previewAutomationConnect, {
  payload: PreviewAutomationHost,
  success: PreviewAutomationStreamEvent,
  error: Schema.Union([PreviewAutomationError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsPreviewAutomationRespondRpc = Rpc.make(WS_METHODS.previewAutomationRespond, {
  payload: PreviewAutomationResponse,
  error: Schema.Union([PreviewAutomationError, EnvironmentAuthorizationError]),
});

export const WsPreviewAutomationFocusHostRpc = Rpc.make(WS_METHODS.previewAutomationFocusHost, {
  payload: PreviewAutomationHostFocus,
  error: EnvironmentAuthorizationError,
});

export const WsSubscribePreviewEventsRpc = Rpc.make(WS_METHODS.subscribePreviewEvents, {
  payload: PreviewEventsSubscribeInput,
  success: PreviewEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeDiscoveredLocalServersRpc = Rpc.make(
  WS_METHODS.subscribeDiscoveredLocalServers,
  {
    payload: Schema.Struct({
      configuredUrls: Schema.optional(ConfiguredLocalServerUrls),
    }),
    success: DiscoveredLocalServerList,
    error: EnvironmentAuthorizationError,
    stream: true,
  },
);

export const WsOrchestrationDispatchCommandRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.dispatchCommand,
  {
    payload: ClientOrchestrationCommand,
    success: OrchestrationRpcSchemas.dispatchCommand.output,
    error: Schema.Union([OrchestrationDispatchCommandError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationGetWorkflowScriptRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getWorkflowScript,
  {
    payload: OrchestrationRpcSchemas.getWorkflowScript.input,
    success: OrchestrationRpcSchemas.getWorkflowScript.output,
    error: Schema.Union([OrchestrationGetWorkflowScriptError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationGetTurnDiffRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getTurnDiff, {
  payload: OrchestrationGetTurnDiffInput,
  success: OrchestrationRpcSchemas.getTurnDiff.output,
  error: Schema.Union([OrchestrationGetTurnDiffError, EnvironmentAuthorizationError]),
});

export const WsOrchestrationGetFullThreadDiffRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getFullThreadDiff,
  {
    payload: OrchestrationGetFullThreadDiffInput,
    success: OrchestrationRpcSchemas.getFullThreadDiff.output,
    error: Schema.Union([OrchestrationGetFullThreadDiffError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationSearchThreadsRpc = Rpc.make(ORCHESTRATION_WS_METHODS.searchThreads, {
  payload: OrchestrationSearchThreadsInput,
  success: OrchestrationRpcSchemas.searchThreads.output,
  error: Schema.Union([OrchestrationSearchThreadsError, EnvironmentAuthorizationError]),
});

export const WsOrchestrationGetArchivedShellSnapshotRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
  {
    payload: OrchestrationRpcSchemas.getArchivedShellSnapshot.input,
    success: OrchestrationRpcSchemas.getArchivedShellSnapshot.output,
    error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationSubscribeShellRpc = Rpc.make(ORCHESTRATION_WS_METHODS.subscribeShell, {
  payload: OrchestrationRpcSchemas.subscribeShell.input,
  success: OrchestrationRpcSchemas.subscribeShell.output,
  error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsOrchestrationSubscribeThreadRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.subscribeThread,
  {
    payload: OrchestrationRpcSchemas.subscribeThread.input,
    success: OrchestrationRpcSchemas.subscribeThread.output,
    error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentAuthorizationError]),
    stream: true,
  },
);

export const WsSubscribeServerConfigRpc = Rpc.make(WS_METHODS.subscribeServerConfig, {
  payload: Schema.Struct({}),
  success: ServerConfigStreamEvent,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsSubscribeServerLifecycleRpc = Rpc.make(WS_METHODS.subscribeServerLifecycle, {
  payload: Schema.Struct({}),
  success: ServerLifecycleStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeAuthAccessRpc = Rpc.make(WS_METHODS.subscribeAuthAccess, {
  payload: Schema.Struct({}),
  success: AuthAccessStreamEvent,
  error: Schema.Union([AuthAccessStreamError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsSubscribeBackgroundPolicyRpc = Rpc.make(WS_METHODS.subscribeBackgroundPolicy, {
  payload: Schema.Struct({}),
  success: BackgroundPolicySnapshot,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeResourceTelemetryRpc = Rpc.make(WS_METHODS.subscribeResourceTelemetry, {
  payload: Schema.Struct({}),
  success: ResourceTelemetrySnapshot,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsRpcGroup = RpcGroup.make(
  WsServerProbeRpc,
  WsServerGetConfigRpc,
  WsServerRefreshProvidersRpc,
  WsServerUpdateProviderRpc,
  WsServerUpdateServerRpc,
  WsServerUpdateServerWithProgressRpc,
  WsServerUpsertKeybindingRpc,
  WsServerRemoveKeybindingRpc,
  WsServerGetSettingsRpc,
  WsServerUpdateSettingsRpc,
  WsComposioGetStatusRpc,
  WsComposioConfigureRpc,
  WsComposioRemoveRpc,
  WsComposioSearchToolkitsRpc,
  WsComposioAuthorizeRpc,
  WsComposioDisconnectRpc,
  WsSubscriptionAuthListRpc,
  WsSubscriptionAuthStartRpc,
  WsSubscriptionAuthPollRpc,
  WsSubscriptionAuthCompleteRpc,
  WsSubscriptionAuthCancelRpc,
  WsSubscriptionAuthLogoutRpc,
  WsSubscriptionAuthHealthTestRpc,
  WsImageProviderListRpc,
  WsImageProviderHealthTestRpc,
  WsMcpServerAuthenticateRpc,
  WsBotInboxListRpc,
  WsBotInboxResolveRpc,
  WsVoiceProvidersRpc,
  WsVoiceConnectRpc,
  WsVoiceDisconnectRpc,
  WsVoiceTestRpc,
  WsVoiceListVoicesRpc,
  WsVoiceTranscribeRpc,
  WsVoiceSynthesizeRpc,
  WsVoiceCancelRpc,
  WsVoiceCallGetRpc,
  WsVoiceCallStartRpc,
  WsVoiceCallHangupRpc,
  WsServerGetTraceDiagnosticsRpc,
  WsServerGetProcessDiagnosticsRpc,
  WsServerGetProcessResourceHistoryRpc,
  WsServerGetResourceTelemetryHistoryRpc,
  WsServerRetryResourceTelemetryRpc,
  WsServerGetUsageSummaryRpc,
  WsServerGetRemoteDoctorRpc,
  WsServerRepairRemoteDoctorRpc,
  WsServerSignalProcessRpc,
  WsServerReportClientActivityRpc,
  WsServerReportHostPowerStateRpc,
  WsServerGetBackgroundPolicyRpc,
  WsMemoryExportRpc,
  WsMemoryImportPreviewRpc,
  WsMemoryImportApplyRpc,
  WsMemoryArchiveExportRpc,
  WsMemoryArchivePreviewImportRpc,
  WsMemoryArchiveApplyImportRpc,
  WsMemoryFactsListRpc,
  WsMemoryFactMutateRpc,
  WsMemoryDocumentsInspectRpc,
  WsMemoryDocumentReplaceRpc,
  WsMemoryObservationsClearRpc,
  WsBotUsageRpc,
  WsPortabilityExportRpc,
  WsPortabilityPreviewImportRpc,
  WsPortabilityApplyImportRpc,
  WsRoutinesListRunsRpc,
  WsRoutinesListThreadRunsRpc,
  WsProjectsListEntriesRpc,
  WsProjectsReadFileRpc,
  WsProjectsSearchEntriesRpc,
  WsProjectsWriteFileRpc,
  WsShellOpenInEditorRpc,
  WsShellRevealAttachmentRpc,
  WsAssetsCreateUrlRpc,
  WsAttachmentsCreateUploadUrlRpc,
  WsAttachmentsDeleteRpc,
  WsProviderUploadFeedbackRpc,
  WsComputerGetStateRpc,
  WsComputerOpenRpc,
  WsComputerAcquireRpc,
  WsComputerInputRpc,
  WsComputerReleaseRpc,
  WsComputerCloseRpc,
  WsComputerStopRpc,
  WsComputerEventsRpc,
  WsPreviewOpenRpc,
  WsPreviewNavigateRpc,
  WsPreviewResizeRpc,
  WsPreviewRefreshRpc,
  WsPreviewCloseRpc,
  WsPreviewListRpc,
  WsPreviewReportStatusRpc,
  WsPreviewAutomationConnectRpc,
  WsPreviewAutomationRespondRpc,
  WsPreviewAutomationFocusHostRpc,
  WsSubscribePreviewEventsRpc,
  WsSubscribeDiscoveredLocalServersRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeServerLifecycleRpc,
  WsSubscribeAuthAccessRpc,
  WsSubscribeBackgroundPolicyRpc,
  WsSubscribeResourceTelemetryRpc,
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationGetWorkflowScriptRpc,
  WsOrchestrationGetTurnDiffRpc,
  WsOrchestrationGetFullThreadDiffRpc,
  WsOrchestrationSearchThreadsRpc,
  WsOrchestrationGetArchivedShellSnapshotRpc,
  WsOrchestrationSubscribeShellRpc,
  WsOrchestrationSubscribeThreadRpc,
);
