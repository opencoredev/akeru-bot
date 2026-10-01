import { type ModelSelection, ThreadId, resolveBotMcpServers } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ProviderAdapterRequestError } from "../../../provider/Errors.ts";
import {
  type ControllerEngineThread,
  resolveControllerBotId,
  type ControllerThreadIdentity,
  providerErrorLabelFromInstanceHint,
} from "./Fields.ts";
import type { createDependencies } from "./Dependencies.ts";

export function createContext({
  projectionSnapshotQuery,
  agentController,
  projectionBotRepository,
  projectionMcpServerRepository,
  composio,
  providerRegistry,
}: Pick<
  Effect.Success<ReturnType<typeof createDependencies>>,
  | "projectionSnapshotQuery"
  | "agentController"
  | "projectionBotRepository"
  | "projectionMcpServerRepository"
  | "composio"
  | "providerRegistry"
>) {
  const resolveThreadShell = Effect.fnUntraced(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadShellById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThreadDetail = Effect.fnUntraced(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId, { activityKinds: [] })
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const inspectAvailableEngine = (modelSelection: ModelSelection) =>
    agentController.inspectEngine(modelSelection);

  const resolveControllerEngine = Effect.fnUntraced(function* (
    thread: ControllerEngineThread,
    fallback: ModelSelection,
  ) {
    const respondingBotId = resolveControllerBotId(thread);

    const bot =
      respondingBotId == null
        ? undefined
        : yield* projectionBotRepository
            .getById({ botId: respondingBotId })
            .pipe(Effect.map(Option.getOrUndefined));

    const engine = bot?.engine ?? null;

    const selection = yield* agentController.resolveEngine({
      threadId: thread.id,
      engine,
      fallback,
      // Plan mode is retired; threads that stored "plan" run in default mode.
      mode: "default",
      botConversation: thread.botId != null || thread.groupId != null,
    });

    return { ...selection, configured: engine !== null };
  });

  const resolveControllerMcpServers = Effect.fnUntraced(function* (
    thread: ControllerThreadIdentity,
  ) {
    const respondingBotId = resolveControllerBotId(thread);

    const bot =
      respondingBotId === null
        ? undefined
        : yield* projectionBotRepository
            .getById({ botId: respondingBotId })
            .pipe(Effect.map(Option.getOrUndefined));

    const servers = yield* projectionMcpServerRepository.listAll();
    const resolved = resolveBotMcpServers(servers, bot?.disabledMcpServerIds ?? []);

    const composioServer = Option.isSome(composio)
      ? yield* composio.value.resolveRuntimeMcpServer(thread.id)
      : undefined;

    return composioServer ? [...resolved, composioServer] : resolved;
  });

  const rejectStartedThreadModelChangeIfRequired = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly currentModelSelection: ModelSelection;
    readonly requestedModelSelection: ModelSelection | undefined;
  }) {
    const requestedModelSelection = input.requestedModelSelection;

    if (
      requestedModelSelection === undefined ||
      (input.currentModelSelection.instanceId === requestedModelSelection.instanceId &&
        input.currentModelSelection.model === requestedModelSelection.model)
    ) {
      return;
    }

    const providers = yield* providerRegistry.getProviders;

    const requiresNewThread =
      providers.find((snapshot) => snapshot.instanceId === input.currentModelSelection.instanceId)
        ?.requiresNewThreadForModelChange === true ||
      providers.find((snapshot) => snapshot.instanceId === requestedModelSelection.instanceId)
        ?.requiresNewThreadForModelChange === true;

    if (!requiresNewThread) {
      return;
    }

    return yield* new ProviderAdapterRequestError({
      provider: providerErrorLabelFromInstanceHint({
        instanceId: String(requestedModelSelection.instanceId),
        modelSelectionInstanceId: String(input.currentModelSelection.instanceId),
      }),
      method: "thread.turn.start",
      detail: `Thread '${input.threadId}' cannot switch models after the conversation has started. Start a new chat to use '${requestedModelSelection.model}'.`,
    });
  });

  return {
    resolveThreadShell,
    resolveThreadDetail,
    inspectAvailableEngine,
    resolveControllerEngine,
    resolveControllerMcpServers,
    rejectStartedThreadModelChangeIfRequired,
  };
}
