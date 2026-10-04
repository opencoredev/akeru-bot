import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import { ComputerError } from "../computer.ts";
import {
  AkeruBotUsageInput,
  AkeruBotUsageReadError,
  AkeruBotUsageSnapshot,
} from "../akeruUsage.ts";
import {
  AkeruMemoryOperationError,
  AkeruMemoryFactsListInput,
  AkeruMemoryFactsListResult,
  AkeruMemoryMutateInput,
  AkeruMemoryMutationResult,
} from "../akeruMemory/facts.ts";
import {
  AkeruMemoryArchiveV2,
  AkeruMemoryExportInput,
  AkeruMemoryImportPreviewInput,
  AkeruMemoryImportPreview,
  AkeruMemoryImportApplyInput,
  AkeruMemoryImportApplyResult,
  AkeruMarkdownMemoryArchiveV3,
  AkeruMarkdownMemoryExportInput,
  AkeruMarkdownMemoryImportApplyInput,
  AkeruMarkdownMemoryImportApplyResult,
  AkeruMarkdownMemoryImportPreview,
  AkeruMarkdownMemoryImportPreviewInput,
} from "../akeruMemory/transfer.ts";
import {
  AkeruMemoryDocumentsInspectInput,
  AkeruMemoryDocumentsSnapshot,
  AkeruMemoryDocumentReplaceInput,
  AkeruMemoryDocument,
  AkeruMemoryObservationsClearInput,
} from "../akeruMemory/documents.ts";
import { ExternalLauncherError, LaunchEditorInput } from "../editor.ts";
import {
  AuthAccessStreamError,
  AuthAccessStreamEvent,
  EnvironmentAuthorizationError,
} from "../auth.ts";
import {
  BackgroundPolicySnapshot,
  ClientActivityReportInput,
  HostPowerSnapshot,
} from "../background.ts";
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
} from "../assets.ts";
import { KeybindingsConfigError } from "../keybindings.ts";
import {
  ProviderUploadFeedbackError,
  ProviderUploadFeedbackInput,
  ProviderUploadFeedbackResult,
} from "../provider.ts";
import { ProviderInstanceId } from "../providerInstance.ts";
import { DiscoveredLocalServerList, ConfiguredLocalServerUrls } from "../preview.ts";
import {
  ServerConfigStreamEvent,
  ServerConfig,
  ServerRemoveKeybindingInput,
  ServerRemoveKeybindingResult,
  ServerUpsertKeybindingInput,
  ServerUpsertKeybindingResult,
} from "../server/config.ts";
import {
  ServerProviderUpdateError,
  ServerProviderUpdateInput,
  ServerProviderUpdatedPayload,
  ServerSelfUpdateError,
  ServerSelfUpdateInput,
  ServerSelfUpdateProgressEvent,
  ServerSelfUpdateResult,
} from "../server/update.ts";
import { ServerLifecycleStreamEvent } from "../server/lifecycle.ts";
import { ServerTraceDiagnosticsResult } from "../server/providers.ts";
import {
  ServerProcessDiagnosticsResult,
  ServerProcessResourceHistoryInput,
  ServerProcessResourceHistoryResult,
  ServerSignalProcessInput,
  ServerSignalProcessResult,
} from "../server/resources.ts";
import {
  ResourceTelemetryHistory,
  ResourceTelemetryHistoryInput,
  ResourceTelemetryRetryResult,
  ResourceTelemetrySnapshot,
} from "../resourceTelemetry.ts";
import { UsageReadError, UsageSummary, UsageSummaryInput } from "../usage.ts";
import {
  RemoteDoctorError,
  RemoteDoctorRepairInput,
  RemoteDoctorStatus,
} from "../remoteDiagnostics.ts";
import { ServerSettings, ServerSettingsError, ServerSettingsRpcPatch } from "../settings/server.ts";
import {
  BotInboxItem,
  BotInboxResolveInput,
  McpServerAuthenticateInput,
  McpServerAuthenticationError,
  McpServerAuthenticationProgress,
  SubscriptionAuthAccountOrderInput,
  SubscriptionAuthCompleteInput,
  SubscriptionAuthError,
  SubscriptionAuthHealthTestInput,
  SubscriptionAuthLoginProgress,
  SubscriptionAuthLogoutInput,
  SubscriptionAuthPollInput,
  SubscriptionAuthStartInput,
  SubscriptionAuthStartResult,
  SubscriptionAuthStatuses,
} from "../subscriptionAuth.ts";
import {
  ImageGenerationError,
  ImageProviderHealthTestInput,
  ImageProviderListResult,
} from "../imageGeneration.ts";
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
} from "../voiceCall.ts";
import {
  PortabilityApplyImportInput,
  PortabilityApplyImportResult,
  PortabilityArchiveError,
  PortabilityExportResult,
  PortabilityImportPreview,
  PortabilityPreviewImportInput,
} from "../portability.ts";
import {
  RoutineListRunsInput,
  RoutineListRunsResult,
  RoutineListThreadRunsResult,
  RoutineListThreadRunsInput,
  RoutineReadError,
  RoutineThreadReadError,
} from "../routines.ts";
import {
  ComposioAuthorizeInput,
  ComposioAuthorizeResult,
  ComposioConfigureInput,
  ComposioDisconnectInput,
  ComposioOperationError,
  ComposioStatus,
  ComposioToolkit,
  ComposioToolkitSearchInput,
} from "../composio.ts";
import { WS_METHODS } from "./methods.ts";

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

export const WsSubscriptionAuthSetAccountOrderRpc = Rpc.make(
  WS_METHODS.subscriptionAuthSetAccountOrder,
  {
    payload: SubscriptionAuthAccountOrderInput,
    success: SubscriptionAuthStatuses,
    error: Schema.Union([SubscriptionAuthError, EnvironmentAuthorizationError]),
  },
);

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

export const computerError = Schema.Union([ComputerError, EnvironmentAuthorizationError]);

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
