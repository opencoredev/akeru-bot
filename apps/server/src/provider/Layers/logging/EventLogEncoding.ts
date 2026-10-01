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

export function logWarning(message: string, context: Record<string, unknown>): Effect.Effect<void> {
  return Effect.logWarning(message, context).pipe(Effect.annotateLogs({ scope: LOG_SCOPE }));
}

export function resolveThreadSegment(raw: string | null | undefined): string {
  const normalized = typeof raw === "string" ? toSafeThreadAttachmentSegment(raw) : null;

  return normalized ?? GLOBAL_THREAD_SEGMENT;
}

export function resolveStreamLabel(stream: EventNdjsonStream): string {
  return stream === "native" ? "NTIVE" : stream === "orchestration" ? "ORCH" : "CANON";
}

export function providerLogPrefix(filePath: string): string {
  const basename = NodePath.basename(filePath);
  const extension = NodePath.extname(basename);

  return `${extension.length > 0 ? basename.slice(0, -extension.length) : basename}.`;
}

export function providerLogPath(directory: string, prefix: string, threadSegment: string): string {
  return NodePath.join(directory, `${prefix}${threadSegment}.log`);
}

export function shouldPersist(stream: EventNdjsonStream, event: unknown): boolean {
  if (stream === "orchestration" || typeof event !== "object" || event === null) {
    return true;
  }

  try {
    const type = Reflect.get(event, "type");

    if (typeof type === "string" && transientCanonicalEventTypes.has(type)) {
      return false;
    }

    if (stream !== "native") return true;

    const nested = Reflect.get(event, "event");
    const nativeEvent = typeof nested === "object" && nested !== null ? nested : event;
    const method = Reflect.get(nativeEvent, "method");

    if (
      typeof method === "string" &&
      (transientNativeMethods.has(method) ||
        method.startsWith("claude/stream_event/content_block_delta/"))
    ) {
      return false;
    }

    const nativeType = Reflect.get(nativeEvent, "type");

    if (nativeType === "message.part.delta") return false;

    const payload = Reflect.get(nativeEvent, "payload");

    if (typeof payload !== "object" || payload === null) return true;

    if (method === "session/update") {
      const update = Reflect.get(payload, "update");

      if (typeof update !== "object" || update === null) return true;
      const updateType = Reflect.get(update, "sessionUpdate");

      return typeof updateType !== "string" || !transientAcpUpdates.has(updateType);
    }

    if (nativeType === "message.part.updated") {
      const properties = Reflect.get(payload, "properties");

      if (typeof properties !== "object" || properties === null) return true;
      const part = Reflect.get(properties, "part");

      if (typeof part !== "object" || part === null) return true;
      const partType = Reflect.get(part, "type");

      return partType !== "text" && partType !== "reasoning";
    }

    return true;
  } catch {
    return true;
  }
}

export const serializeEvent = Effect.fnUntraced(function* (event: unknown) {
  return yield* encodeUnknownJsonString(event).pipe(
    Effect.catch((error) =>
      logWarning("failed to serialize provider event log record", {
        errorTag: errorTag(error),
      }).pipe(Effect.as(undefined)),
    ),
  );
});
