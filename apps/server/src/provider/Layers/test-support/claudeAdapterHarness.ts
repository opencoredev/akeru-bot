import { claudeMessage } from "./claudeMessages.ts";
import * as Predicate from "effect/Predicate";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  Options as ClaudeQueryOptions,
  PermissionMode,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ClaudeSettings,
  ProviderRuntimeEvent,
  ThreadId,
  ProviderInstanceId,
} from "@akeru/contracts";
import { assert } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ServerConfig } from "../../../config.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import type { ClaudeAdapterShape } from "../../Services/ClaudeAdapter.ts";
import { makeClaudeAdapter, type ClaudeAdapterLiveOptions } from "../ClaudeAdapter.ts";

export const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

export class ClaudeAdapter extends Context.Service<ClaudeAdapter, ClaudeAdapterShape>()(
  "akeru-bot/provider/Layers/test-support/claudeAdapterHarness/ClaudeAdapter",
) {}

export class FakeClaudeQuery implements AsyncIterable<SDKMessage> {
  private readonly queue: Array<SDKMessage> = [];
  private readonly waiters: Array<{
    readonly resolve: (value: IteratorResult<SDKMessage>) => void;
    readonly reject: (cause: unknown) => void;
  }> = [];
  private done = false;
  private failure: unknown | undefined;

  public readonly setModelCalls: Array<string | undefined> = [];
  public readonly setPermissionModeCalls: Array<string> = [];
  public readonly setMaxThinkingTokensCalls: Array<number | null> = [];
  public closeCalls = 0;
  public closeError: unknown | undefined;

  emit(message: SDKMessage): void {
    if (this.done) {
      return;
    }

    const waiter = this.waiters.shift();

    if (waiter) {
      waiter.resolve({ done: false, value: message });

      return;
    }

    this.queue.push(message);
  }

  fail(cause: unknown): void {
    if (this.done) {
      return;
    }

    this.done = true;
    this.failure = cause;

    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(cause);
    }
  }

  finish(): void {
    if (this.done) {
      return;
    }

    this.done = true;
    this.failure = undefined;

    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  readonly setModel = async (model?: string): Promise<void> => {
    this.setModelCalls.push(model);
  };

  readonly setPermissionMode = async (mode: PermissionMode): Promise<void> => {
    this.setPermissionModeCalls.push(mode);
  };

  readonly setMaxThinkingTokens = async (maxThinkingTokens: number | null): Promise<void> => {
    this.setMaxThinkingTokensCalls.push(maxThinkingTokens);
  };

  close = (): void => {
    this.closeCalls += 1;

    if (this.closeError !== undefined) {
      throw this.closeError;
    }

    this.finish();
  };

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          const value = this.queue.shift();

          if (value) {
            return Promise.resolve({
              done: false,
              value,
            });
          }
        }

        if (this.failure !== undefined) {
          const failure = this.failure;
          this.failure = undefined;

          return Promise.reject(failure);
        }

        if (this.done) {
          return Promise.resolve({
            done: true,
            value: undefined,
          });
        }

        return new Promise((resolve, reject) => {
          this.waiters.push({
            resolve,
            reject,
          });
        });
      },
    };
  }
}

export function makeHarness(config?: {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: ClaudeAdapterLiveOptions["nativeEventLogger"];
  readonly cwd?: string;
  readonly baseDir?: string;
  readonly claudeConfig?: Partial<ClaudeSettings>;
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: ClaudeAdapterLiveOptions["environment"];
}) {
  const query = new FakeClaudeQuery();

  let createInput:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
        readonly options: ClaudeQueryOptions;
      }
    | undefined;

  const adapterOptions: ClaudeAdapterLiveOptions = {
    ...(config?.environment ? { environment: config.environment } : {}),
    ...(config?.instanceId ? { instanceId: config.instanceId } : {}),
    createQuery: (input) => {
      createInput = input;

      return query;
    },
    ...(config?.nativeEventLogger
      ? {
          nativeEventLogger: config.nativeEventLogger,
        }
      : {}),
    ...(config?.nativeEventLogPath
      ? {
          nativeEventLogPath: config.nativeEventLogPath,
        }
      : {}),
  };

  return {
    layer: Layer.effect(
      ClaudeAdapter,
      Effect.gen(function* () {
        const claudeConfig = decodeClaudeSettings(config?.claudeConfig ?? {});

        return yield* makeClaudeAdapter(claudeConfig, adapterOptions);
      }),
    ).pipe(
      Layer.provideMerge(
        ServerConfig.layerTest(
          config?.cwd ?? "/tmp/claude-adapter-test",
          config?.baseDir ?? "/tmp",
        ),
      ),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    ),
    query,
    getLastCreateQueryInput: () => createInput,
  };
}

export function makeDeterministicRandomService(seed = 0x1234_5678) {
  let state = seed >>> 0;

  const nextIntUnsafe = (): number => {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;

    return state;
  };

  return {
    nextIntUnsafe,
    nextDoubleUnsafe: () => nextIntUnsafe() / 0x1_0000_0000,
  };
}

export async function readFirstPromptText(
  input:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
      }
    | undefined,
): Promise<string | undefined> {
  const iterator = input?.prompt[Symbol.asyncIterator]();

  if (!iterator) {
    return undefined;
  }

  const next = await iterator.next();

  if (next.done) {
    return undefined;
  }

  if (Predicate.isString(next.value.message.content)) {
    return next.value.message.content;
  }

  const content = next.value.message.content[0];

  if (!content || content.type !== "text") {
    return undefined;
  }

  return content.text;
}

export async function readFirstPromptMessage(
  input:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
      }
    | undefined,
): Promise<SDKUserMessage | undefined> {
  const iterator = input?.prompt[Symbol.asyncIterator]();

  if (!iterator) {
    return undefined;
  }

  const next = await iterator.next();

  if (next.done) {
    return undefined;
  }

  return next.value;
}

export const THREAD_ID = ThreadId.make("thread-claude-1");

export const RESUME_THREAD_ID = ThreadId.make("thread-claude-resume");

export const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.String));

export const completedTurn = (runtimeEvents: ReadonlyArray<ProviderRuntimeEvent>) => {
  const event = runtimeEvents[runtimeEvents.length - 1];
  assert.equal(event?.type, "turn.completed");
  assert(event?.type === "turn.completed");

  return event.payload;
};

export const AUTH_FAILURE_ASSISTANT = claudeMessage({
  type: "assistant",
  session_id: "sdk-session-auth",
  uuid: "assistant-auth",
  parent_tool_use_id: null,
  error: "authentication_failed",
  is_api_error_message: true,
  message: {
    id: "assistant-message-auth",
    model: "<synthetic>",
    content: [{ type: "text", text: "Not logged in · Please run /login" }],
  },
});

export const usageLimitMessage =
  "Claude usage limit reached. Send the message again once the limit resets.";

export const genericApiErrorMessage = "Claude gave up after repeated API errors.";

export const rateLimitAssistant = {
  type: "assistant",
  session_id: "sdk-session-limit",
  uuid: "assistant-limit",
  parent_tool_use_id: null,
  error: "rate_limit",
  message: {
    id: "assistant-message-limit",
    model: "<synthetic>",
    content: [{ type: "text", text: "You've hit your session limit" }],
  },
};

export const rateLimitResult = {
  type: "result",
  subtype: "success",
  is_error: true,
  terminal_reason: "api_error",
  session_id: "sdk-session-limit",
  uuid: "result-limit",
};
