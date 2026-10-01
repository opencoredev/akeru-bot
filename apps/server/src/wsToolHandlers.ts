import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { computerRegistry } from "./provider/computerRegistry.ts";
import * as Effect from "effect/Effect";
import { WS_METHODS, WsRpcGroup } from "@akeru/contracts";

import type { WsConnection } from "./wsConnection.ts";

export const createWsToolHandlers = ({
  voiceCallOwnerId,
  computerClient,
  computerOperation,
  previewManager,
  observeRpcEffect,
  observeRpcStream,
  observeRpcStreamEffect,
  previewAutomationBroker,
  voiceCalls,
}: Pick<
  WsConnection,
  | "voiceCallOwnerId"
  | "computerClient"
  | "computerOperation"
  | "previewManager"
  | "observeRpcEffect"
  | "observeRpcStream"
  | "observeRpcStreamEffect"
  | "previewAutomationBroker"
  | "voiceCalls"
>) =>
  ({
    [WS_METHODS.voiceProviders]: () => voiceCalls.providers,

    [WS_METHODS.voiceConnect]: ({ provider, apiKey }) => voiceCalls.connect(provider, apiKey),

    [WS_METHODS.voiceDisconnect]: ({ provider }) => voiceCalls.disconnect(provider),

    [WS_METHODS.voiceTest]: ({ provider }) => voiceCalls.test(provider),

    [WS_METHODS.voiceListVoices]: ({ provider, cursor }) => voiceCalls.listVoices(provider, cursor),

    [WS_METHODS.voiceTranscribe]: (input) => voiceCalls.transcribe(input, voiceCallOwnerId),

    [WS_METHODS.voiceSynthesize]: (input) => voiceCalls.synthesize(input, voiceCallOwnerId),

    [WS_METHODS.voiceCancel]: ({ operationId }) => voiceCalls.cancel(operationId, voiceCallOwnerId),

    [WS_METHODS.voiceCallGet]: (_input) =>
      observeRpcEffect(WS_METHODS.voiceCallGet, voiceCalls.get, {
        "rpc.aggregate": "voice-call",
      }),

    [WS_METHODS.voiceCallStart]: (input) =>
      observeRpcEffect(WS_METHODS.voiceCallStart, voiceCalls.start(input, voiceCallOwnerId), {
        "rpc.aggregate": "voice-call",
      }),

    [WS_METHODS.voiceCallHangup]: ({ callId }) =>
      observeRpcEffect(WS_METHODS.voiceCallHangup, voiceCalls.hangup(callId, voiceCallOwnerId), {
        "rpc.aggregate": "voice-call",
      }),

    [WS_METHODS.computerGetState]: (input) =>
      Effect.sync(() => computerRegistry.state(input.threadId)),

    [WS_METHODS.computerOpen]: (input, metadata) =>
      computerOperation(computerClient(metadata.client.id), () =>
        computerRegistry.open(input.threadId),
      ),

    [WS_METHODS.computerAcquire]: (input, metadata) =>
      computerOperation(computerClient(metadata.client.id), () =>
        computerRegistry.acquire(input.threadId, computerClient(metadata.client.id)),
      ),

    [WS_METHODS.computerInput]: (input, metadata) =>
      computerOperation(computerClient(metadata.client.id), () =>
        computerRegistry.input(input, computerClient(metadata.client.id)),
      ),

    [WS_METHODS.computerRelease]: (input, metadata) =>
      computerOperation(computerClient(metadata.client.id), () =>
        computerRegistry.release(input, computerClient(metadata.client.id)),
      ),

    [WS_METHODS.computerClose]: (input, metadata) =>
      computerOperation(computerClient(metadata.client.id), () =>
        computerRegistry.close(input.threadId, computerClient(metadata.client.id)),
      ),

    [WS_METHODS.computerStop]: (input, metadata) =>
      computerOperation(computerClient(metadata.client.id), () =>
        Promise.resolve(computerRegistry.stop(input.threadId)),
      ),

    [WS_METHODS.computerEvents]: (input, metadata) =>
      observeRpcStreamEffect(
        WS_METHODS.computerEvents,
        Effect.succeed(computerRegistry.events(input.threadId, computerClient(metadata.client.id))),
        { "rpc.aggregate": "computer" },
      ),

    [WS_METHODS.previewOpen]: (input) =>
      observeRpcEffect(WS_METHODS.previewOpen, previewManager.open(input), {
        "rpc.aggregate": "preview",
      }),

    [WS_METHODS.previewNavigate]: (input) =>
      observeRpcEffect(WS_METHODS.previewNavigate, previewManager.navigate(input), {
        "rpc.aggregate": "preview",
      }),

    [WS_METHODS.previewResize]: (input) =>
      observeRpcEffect(WS_METHODS.previewResize, previewManager.resize(input), {
        "rpc.aggregate": "preview",
      }),

    [WS_METHODS.previewRefresh]: (input) =>
      observeRpcEffect(WS_METHODS.previewRefresh, previewManager.refresh(input), {
        "rpc.aggregate": "preview",
      }),

    [WS_METHODS.previewClose]: (input) =>
      observeRpcEffect(WS_METHODS.previewClose, previewManager.close(input), {
        "rpc.aggregate": "preview",
      }),

    [WS_METHODS.previewList]: (input) =>
      observeRpcEffect(WS_METHODS.previewList, previewManager.list(input), {
        "rpc.aggregate": "preview",
      }),

    [WS_METHODS.previewReportStatus]: (input) =>
      observeRpcEffect(WS_METHODS.previewReportStatus, previewManager.reportStatus(input), {
        "rpc.aggregate": "preview",
      }),

    [WS_METHODS.previewAutomationConnect]: (input) =>
      observeRpcStreamEffect(
        WS_METHODS.previewAutomationConnect,
        previewAutomationBroker.connect(input),
        { "rpc.aggregate": "preview-automation" },
      ),

    [WS_METHODS.previewAutomationRespond]: (input) =>
      observeRpcEffect(
        WS_METHODS.previewAutomationRespond,
        previewAutomationBroker.respond(input),
        { "rpc.aggregate": "preview-automation" },
      ),

    [WS_METHODS.previewAutomationFocusHost]: (input) =>
      observeRpcEffect(
        WS_METHODS.previewAutomationFocusHost,
        previewAutomationBroker.focusHost(input),
        { "rpc.aggregate": "preview-automation" },
      ),

    [WS_METHODS.subscribePreviewEvents]: (input) =>
      observeRpcStream(WS_METHODS.subscribePreviewEvents, previewManager.streamEvents(input), {
        "rpc.aggregate": "preview",
      }),
  }) satisfies Pick<
    RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof WsRpcGroup>>,
    | typeof WS_METHODS.voiceProviders
    | typeof WS_METHODS.voiceConnect
    | typeof WS_METHODS.voiceDisconnect
    | typeof WS_METHODS.voiceTest
    | typeof WS_METHODS.voiceListVoices
    | typeof WS_METHODS.voiceTranscribe
    | typeof WS_METHODS.voiceSynthesize
    | typeof WS_METHODS.voiceCancel
    | typeof WS_METHODS.voiceCallGet
    | typeof WS_METHODS.voiceCallStart
    | typeof WS_METHODS.voiceCallHangup
    | typeof WS_METHODS.computerGetState
    | typeof WS_METHODS.computerOpen
    | typeof WS_METHODS.computerAcquire
    | typeof WS_METHODS.computerInput
    | typeof WS_METHODS.computerRelease
    | typeof WS_METHODS.computerClose
    | typeof WS_METHODS.computerStop
    | typeof WS_METHODS.computerEvents
    | typeof WS_METHODS.previewOpen
    | typeof WS_METHODS.previewNavigate
    | typeof WS_METHODS.previewResize
    | typeof WS_METHODS.previewRefresh
    | typeof WS_METHODS.previewClose
    | typeof WS_METHODS.previewList
    | typeof WS_METHODS.previewReportStatus
    | typeof WS_METHODS.previewAutomationConnect
    | typeof WS_METHODS.previewAutomationRespond
    | typeof WS_METHODS.previewAutomationFocusHost
    | typeof WS_METHODS.subscribePreviewEvents
  >;
