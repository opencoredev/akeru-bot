import * as Predicate from "effect/Predicate";
import type { ProviderDriverKind, ThreadId } from "@akeru/contracts";
import { causeErrorTag, errorTag } from "@akeru/shared/observability";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as EffectAcpProtocol from "effect-acp/protocol";

import type { EventNdjsonLogger } from "../Layers/logging/EventLogTypes.ts";
import type * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const transientProtocolUpdates = new Set(["agent_message_chunk", "agent_thought_chunk"]);

function structuralMethod(value: string): string {
  return value.length <= 128 && /^[A-Za-z][A-Za-z0-9._:/-]*$/.test(value) ? value : "unknown";
}

function summarizePayload<Payload>(payload: Payload) {
  if (payload === null) return { valueType: "null" };

  if (Predicate.isString(payload)) {
    return { valueType: "string", byteLength: new TextEncoder().encode(payload).byteLength };
  }

  if (payload instanceof Uint8Array) {
    return { valueType: "bytes", byteLength: payload.byteLength };
  }

  if (Array.isArray(payload)) {
    return { valueType: "array", itemCount: payload.length };
  }

  if (!Predicate.isObject(payload)) {
    const valueType = Predicate.isUndefined(payload)
      ? "undefined"
      : Predicate.isBoolean(payload)
        ? "boolean"
        : Predicate.isNumber(payload)
          ? "number"
          : Predicate.isBigInt(payload)
            ? "bigint"
            : Predicate.isSymbol(payload)
              ? "symbol"
              : "function";

    return { valueType };
  }

  try {
    const record = payload;

    return {
      valueType: "object",
      fieldCount: Object.keys(record).length,
      ...(Predicate.isString(record._tag) ? { messageTag: errorTag(record) } : {}),
      ...(Predicate.isString(record.tag) ? { method: structuralMethod(record.tag) } : {}),
    };
  } catch {
    return { valueType: "object" };
  }
}

function formatRequestLogPayload(event: AcpSessionRuntime.AcpSessionRequestLogEvent) {
  return {
    method: structuralMethod(event.method),
    status: event.status,
    request: summarizePayload(event.payload),
    ...(event.result !== undefined ? { result: summarizePayload(event.result) } : {}),
    ...(event.cause !== undefined
      ? {
          errorTag: causeErrorTag(event.cause),
          reasonCount: event.cause.reasons.length,
        }
      : {}),
  };
}

function formatProtocolLogPayload(event: EffectAcpProtocol.AcpProtocolLogEvent) {
  return {
    direction: event.direction,
    stage: event.stage,
    payload: summarizePayload(event.payload),
  };
}

function isTransientProtocolMessage<Message>(message: Message): boolean {
  if (!Predicate.isObjectOrArray(message) || message === null) return false;

  const method =
    ("tag" in message ? message.tag : undefined) ??
    ("method" in message ? message.method : undefined);

  if (method !== "session/update") return false;

  const payload =
    ("payload" in message ? message.payload : undefined) ??
    ("params" in message ? message.params : undefined);

  if (!Predicate.isObjectOrArray(payload) || payload === null) return false;
  const update = "update" in payload ? payload.update : undefined;

  if (!Predicate.isObjectOrArray(update) || update === null) return false;
  const updateType = "sessionUpdate" in update ? update.sessionUpdate : undefined;

  return Predicate.isString(updateType) && transientProtocolUpdates.has(updateType);
}

function rawChunkContainsOnlyTransientMessages(payload: string): boolean {
  const lines = payload.split("\n");
  const remainder = lines.pop() ?? "";

  if (remainder.trim().length > 0) return false;

  const messages: Array<unknown> = [];

  for (const line of lines) {
    if (line.trim().length === 0) continue;

    try {
      messages.push(JSON.parse(line));
    } catch {
      return false;
    }
  }

  return messages.length > 0 && messages.every(isTransientProtocolMessage);
}

function filterTransientProtocolLog(
  event: EffectAcpProtocol.AcpProtocolLogEvent,
): EffectAcpProtocol.AcpProtocolLogEvent | undefined {
  if (event.direction !== "incoming") return event;

  if (event.stage === "raw" && Predicate.isString(event.payload)) {
    return rawChunkContainsOnlyTransientMessages(event.payload) ? undefined : event;
  }

  if (event.stage !== "decoded") return event;

  if (!Array.isArray(event.payload)) {
    return isTransientProtocolMessage(event.payload) ? undefined : event;
  }

  const payload = event.payload.filter((message) => !isTransientProtocolMessage(message));

  return payload.length === 0 ? undefined : { ...event, payload };
}

export const makeAcpNativeLoggerFactory = Effect.fn("makeAcpNativeLoggerFactory")(function* () {
  const crypto = yield* Crypto.Crypto;

  return (input: {
    readonly nativeEventLogger: EventNdjsonLogger | undefined;
    readonly provider: ProviderDriverKind;
    readonly threadId: ThreadId;
    readonly verboseProtocolLogging?: boolean;
  }): Pick<AcpSessionRuntime.AcpSessionRuntimeOptions, "requestLogger" | "protocolLogging"> => {
    const writeNativeAcpLog = <Payload>(logInput: {
      readonly kind: "request" | "protocol";
      readonly payload: Payload;
    }) =>
      Effect.gen(function* () {
        if (!input.nativeEventLogger) return;
        const observedAt = DateTime.formatIso(yield* DateTime.now);
        yield* input.nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* crypto.randomUUIDv4,
              kind: logInput.kind,
              provider: input.provider,
              createdAt: observedAt,
              threadId: input.threadId,
              payload: logInput.payload,
            },
          },
          input.threadId,
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logWarning("Failed to write native ACP event log.", {
                errorTag: causeErrorTag(cause),
                reasonCount: cause.reasons.length,
                provider: input.provider,
                threadId: input.threadId,
              }),
        ),
      );

    return {
      requestLogger: (event: AcpSessionRuntime.AcpSessionRequestLogEvent) =>
        writeNativeAcpLog({
          kind: "request",
          payload: formatRequestLogPayload(event),
        }),
      ...(input.nativeEventLogger && input.verboseProtocolLogging
        ? {
            protocolLogging: {
              logIncoming: true,
              logOutgoing: true,
              logger: (event: EffectAcpProtocol.AcpProtocolLogEvent) => {
                const filtered = filterTransientProtocolLog(event);

                return filtered
                  ? writeNativeAcpLog({
                      kind: "protocol",
                      payload: formatProtocolLogPayload(filtered),
                    })
                  : Effect.void;
              },
            } satisfies NonNullable<AcpSessionRuntime.AcpSessionRuntimeOptions["protocolLogging"]>,
          }
        : {}),
    };
  };
});
