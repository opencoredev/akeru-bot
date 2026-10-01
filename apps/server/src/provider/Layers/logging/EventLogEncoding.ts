import * as Match from "effect/Match";

import * as Predicate from "effect/Predicate";
// @effect-diagnostics nodeBuiltinImport:off

import * as NodePath from "node:path";
import { errorTag } from "@akeru/shared/observability";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { toSafeThreadAttachmentSegment } from "../../../attachmentStore.ts";

import { GLOBAL_THREAD_SEGMENT, LOG_SCOPE, type EventNdjsonStream } from "./EventLogTypes.ts";

export const encodeUnknownJsonString = Schema.encodeUnknownEffect(
  Schema.fromJsonString(Schema.Unknown),
);

export const transientCanonicalEventTypes = new Set([
  "content.delta",
  "hook.progress",
  "item.updated",
  "task.progress",
  "thread.realtime.audio.delta",
  "tool.progress",
  "turn.proposed.delta",
]);

export const transientNativeMethods = new Set([
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "thread/realtime/outputAudio/delta",
  "thread/realtime/transcript/delta",
]);

export const transientAcpUpdates = new Set(["agent_message_chunk", "agent_thought_chunk"]);

export function logWarning(
  message: string,
  context: Record<string, string | number | Error>,
): Effect.Effect<void> {
  return Effect.logWarning(message, context).pipe(Effect.annotateLogs({ scope: LOG_SCOPE }));
}

export function resolveThreadSegment(raw: string | null | undefined): string {
  const normalized = Predicate.isString(raw) ? toSafeThreadAttachmentSegment(raw) : null;

  return normalized ?? GLOBAL_THREAD_SEGMENT;
}

export function resolveStreamLabel(stream: EventNdjsonStream): string {
  return Match.value(stream).pipe(
    Match.when("native", () => "NTIVE" as const),
    Match.when("orchestration", () => "ORCH" as const),
    Match.orElse(() => "CANON" as const),
  );
}

export function providerLogPrefix(filePath: string): string {
  const basename = NodePath.basename(filePath);
  const extension = NodePath.extname(basename);

  return `${extension.length > 0 ? basename.slice(0, -extension.length) : basename}.`;
}

export function providerLogPath(directory: string, prefix: string, threadSegment: string): string {
  return NodePath.join(directory, `${prefix}${threadSegment}.log`);
}

export function shouldPersist<Input0>(stream: EventNdjsonStream, eventInput: Input0): boolean {
  const event = eventInput;

  if (stream === "orchestration" || !Predicate.isObject(event)) {
    return true;
  }

  try {
    const type = event.type;

    if (Predicate.isString(type) && transientCanonicalEventTypes.has(type)) {
      return false;
    }

    if (stream !== "native") return true;

    const nested = event.event;

    const nativeEvent = Predicate.isObject(nested) ? nested : event;

    const method = nativeEvent.method;

    if (
      Predicate.isString(method) &&
      (transientNativeMethods.has(method) ||
        method.startsWith("claude/stream_event/content_block_delta/"))
    ) {
      return false;
    }

    const nativeType = nativeEvent.type;

    if (nativeType === "message.part.delta") return false;

    const payload = nativeEvent.payload;

    if (!Predicate.isObject(payload) || payload === null) return true;

    if (method === "session/update") {
      const update = payload.update;

      if (!Predicate.isObject(update) || update === null) return true;
      const updateType = update.sessionUpdate;

      return !Predicate.isString(updateType) || !transientAcpUpdates.has(updateType);
    }

    if (nativeType === "message.part.updated") {
      const properties = payload.properties;

      if (!Predicate.isObject(properties) || properties === null) return true;
      const part = properties.part;

      if (!Predicate.isObject(part) || part === null) return true;
      const partType = part.type;

      return partType !== "text" && partType !== "reasoning";
    }

    return true;
  } catch {
    return true;
  }
}

export const serializeEvent = Effect.fnUntraced(function* <Event>(event: Event) {
  return yield* encodeUnknownJsonString(event).pipe(
    Effect.catch((error) =>
      logWarning("failed to serialize provider event log record", {
        errorTag: errorTag(error),
      }).pipe(Effect.as(undefined)),
    ),
  );
});
