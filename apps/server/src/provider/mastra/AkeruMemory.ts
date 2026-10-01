import * as Predicate from "effect/Predicate";
// @effect-diagnostics globalFetch:off nodeBuiltinImport:off
import * as NodeURL from "node:url";
import { RequestContext } from "@mastra/core/request-context";
import {
  type Processor,
  type ProcessInputStepArgs,
  type ProcessOutputResultArgs,
} from "@mastra/core/processors";
import { LibSQLStore } from "@mastra/libsql";
import { Memory } from "@mastra/memory";
import {
  ObservationalMemory,
  OBSERVATION_CONTINUATION_HINT,
  type ObserveHooks,
} from "@mastra/memory/processors";
import { selectRecentConversation } from "../RecentConversation.ts";
import { type AkeruMastraHarnessOptions, type AkeruMastraState } from "./AkeruHarnessTypes.ts";
import { DEFAULT_MODEL_ID, resolveAkeruMastraModel } from "./AkeruModels.ts";

export function createAkeruObserveHooks(
  options: Pick<AkeruMastraHarnessOptions, "startMemoryCall" | "finishMemoryCall">,
): ObserveHooks {
  const active = new Map<string, string>();

  const start = async (threadId: string | undefined, category: "observer" | "reflector") => {
    if (!threadId) return;
    const callId = await options.startMemoryCall?.({ threadId, category });

    if (callId) active.set(`${threadId}:${category}`, callId);
  };

  const finish = async (
    category: "observer" | "reflector",
    result: Parameters<NonNullable<ObserveHooks["onObservationEnd"]>>[0],
  ) => {
    if (!result.threadId) return;
    const key = `${result.threadId}:${category}`;
    const callId = active.get(key);

    if (!callId) return;
    active.delete(key);
    await options.finishMemoryCall?.({
      callId,
      category,
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.error ? { error: result.error } : {}),
    });
  };

  return {
    onObservationStart: ({ threadId } = {}) => start(threadId, "observer"),
    onObservationEnd: (result) => finish("observer", result),
    onReflectionStart: ({ threadId } = {}) => start(threadId, "reflector"),
    onReflectionEnd: (result) => finish("reflector", result),
  };
}

export function controllerContext(
  requestContext: RequestContext,
): Record<string, unknown> | undefined {
  const value = requestContext.getRaw("controller");

  return Predicate.isObjectOrArray(value) && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

export function controllerModelId(requestContext: RequestContext): string {
  const value = controllerContext(requestContext);

  if (!value || !("session" in value)) return DEFAULT_MODEL_ID;
  const session = value.session;

  if (!Predicate.isObjectOrArray(session) || session === null || !("modelId" in session)) {
    return DEFAULT_MODEL_ID;
  }

  return Predicate.isString(session.modelId) ? session.modelId : DEFAULT_MODEL_ID;
}

export function controllerModelOptions(
  requestContext: RequestContext,
): AkeruMastraState["modelOptions"] {
  const state = controllerContext(requestContext)?.state;

  if (!Predicate.isObjectOrArray(state) || state === null || !("modelOptions" in state)) {
    return undefined;
  }

  const modelOptions = state.modelOptions;

  return Predicate.isObjectOrArray(modelOptions) && modelOptions !== null
    ? (modelOptions as AkeruMastraState["modelOptions"])
    : undefined;
}

export function controllerModelConnection(
  requestContext: RequestContext,
  getModelConnection: AkeruMastraHarnessOptions["getModelConnection"],
) {
  const state = controllerContext(requestContext)?.state;

  if (!Predicate.isObjectOrArray(state) || state === null || !("providerInstanceId" in state)) {
    return undefined;
  }

  return Predicate.isString(state.providerInstanceId)
    ? getModelConnection?.(state.providerInstanceId)
    : undefined;
}

export function controllerResourceId(requestContext: RequestContext): string | undefined {
  const value = controllerContext(requestContext)?.resourceId;

  return Predicate.isString(value) ? value : undefined;
}

export class AkeruPassiveObservationalMemoryProcessor implements Processor<"observational-memory"> {
  readonly id = "observational-memory" as const;
  readonly name = "Akeru Observational Memory";
  readonly engine: ObservationalMemory;
  private readonly memory: Memory;

  constructor(engine: ObservationalMemory, memory: Memory) {
    this.engine = engine;
    this.memory = memory;
  }

  async processInputStep(args: ProcessInputStepArgs) {
    if (args.stepNumber !== 0) return args.messageList;
    const context = this.engine.getThreadContext(args.requestContext, args.messageList);

    if (!context) return args.messageList;

    const [history, unobserved] = await Promise.all([
      this.memory.recall({ threadId: context.threadId, perPage: false }),
      this.engine.loadUnobservedMessages({
        threadId: context.threadId,
        ...(context.resourceId ? { resourceId: context.resourceId } : {}),
      }),
    ]);

    const requiredMessageIds = new Set(unobserved.map((message) => message.id));

    for (const message of selectRecentConversation(history.messages, { requiredMessageIds })) {
      if (message.role !== "system") args.messageList.add(message, "memory");
    }

    const record = await this.engine.getOrCreateRecord(context.threadId, context.resourceId);
    const chunks = await this.engine.buildContextSystemMessages({ ...context, record });
    args.messageList.clearSystemMessages("observational-memory");

    for (const chunk of chunks ?? []) args.messageList.addSystem(chunk, "observational-memory");
    args.messageList.clearSystemMessages("om-continuation");

    if (record.activeObservations) {
      args.messageList.addSystem(
        `<system-reminder>${OBSERVATION_CONTINUATION_HINT}</system-reminder>`,
        "om-continuation",
      );
    }

    return args.messageList;
  }

  async processOutputResult(args: ProcessOutputResultArgs) {
    const messages = [
      ...args.messageList.get.input.db(),
      ...args.messageList.get.response.db(),
    ].filter((message) => args.messageList.isNewMessage(message));

    if (messages.length > 0) await this.memory.persistMessages(messages);

    return args.messageList;
  }
}

export async function createAkeruMastraMemory(
  options: Pick<
    AkeruMastraHarnessOptions,
    | "authStorage"
    | "getKimiAccess"
    | "getOpenCodeGoApiKey"
    | "getSubscriptionApiKey"
    | "getSubscriptionOAuth"
    | "getSubscriptionAccessToken"
    | "getModelConnection"
    | "memoryDbPath"
  >,
) {
  const storage = new LibSQLStore({
    id: "akeru-observational-memory",
    url: NodeURL.pathToFileURL(options.memoryDbPath).toString(),
    connectionTimeoutMs: 5_000,
  });

  await storage.init();

  const model = ({ requestContext }: { readonly requestContext: RequestContext }) =>
    resolveAkeruMastraModel(
      controllerModelId(requestContext),
      options.authStorage,
      options.getKimiAccess,
      options.getOpenCodeGoApiKey,
      undefined,
      options.getSubscriptionApiKey,
      controllerModelConnection(requestContext, options.getModelConnection),
      options.getSubscriptionOAuth,
      options.getSubscriptionAccessToken,
    );

  const memory = new Memory({
    storage,
    options: {
      lastMessages: false,
      semanticRecall: false,
      workingMemory: { enabled: false },
      observationalMemory: false,
    },
  });

  const memoryStore = await storage.getStore("memory");

  if (!memoryStore?.supportsObservationalMemory) {
    await storage.close();
    throw new Error("The configured memory store does not support observational memory.");
  }

  const engine = new ObservationalMemory({
    storage: memoryStore,
    memory,
    scope: "thread",
    model,
    retrieval: false,
    hookExecution: "await",
    observation: {
      bufferTokens: false,
      bufferOnIdle: false,
      continuationHints: { currentTask: true, suggestedResponse: true },
    },
    reflection: {
      continuationHints: { currentTask: true, suggestedResponse: true },
    },
  });

  const processor = new AkeruPassiveObservationalMemoryProcessor(engine, memory);
  let closePromise: Promise<void> | undefined;

  return {
    memory,
    storage,
    engine,
    processor,
    close: async () => {
      closePromise ??= (async () => {
        await engine.settled();
        await storage.close();
      })();
      await closePromise;
    },
  };
}
