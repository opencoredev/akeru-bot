import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as EffectAcpSchema from "effect-acp/schema";
import { decideToolCallUpdateEmission, mergeToolCallState } from "./AcpToolCalls.ts";
import { parseSessionUpdateEvent } from "./AcpRuntimeModel.ts";
import {
  type AcpParsedSessionEvent,
  type AcpSessionModeState,
  type AcpToolCallState,
} from "./AcpRuntimeTypes.ts";

import { type AcpSessionRuntimeEvent } from "./AcpSessionEventTypes.ts";

export interface AcpToolCallTrackedState {
  readonly state: AcpToolCallState;
  readonly lastEmittedDetailLength: number | undefined;
  readonly skippedSinceEmit: number;
}

export interface AcpAssistantSegmentState {
  readonly nextSegmentIndex: number;
  readonly activeItemId?: string;
}

export interface EnsureActiveAssistantSegmentResult {
  readonly itemId: string;
  readonly startedEvent?: Extract<AcpParsedSessionEvent, { readonly _tag: "AssistantItemStarted" }>;
}

export const handleSessionUpdate = ({
  queue,
  modeStateRef,
  toolCallsRef,
  assistantSegmentRef,
  assistantItemRuntimeId,
  params,
}: {
  readonly queue: Queue.Queue<AcpSessionRuntimeEvent>;
  readonly modeStateRef: Ref.Ref<AcpSessionModeState | undefined>;
  readonly toolCallsRef: Ref.Ref<Map<string, AcpToolCallTrackedState>>;
  readonly assistantSegmentRef: Ref.Ref<AcpAssistantSegmentState>;
  readonly assistantItemRuntimeId: string;
  readonly params: EffectAcpSchema.SessionNotification;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const parsed = parseSessionUpdateEvent(params);
    if (parsed.modeId) {
      yield* Ref.update(modeStateRef, (current) =>
        current === undefined ? current : updateModeState(current, parsed.modeId!),
      );
    }
    for (const event of parsed.events) {
      if (event._tag === "ToolCallUpdated") {
        yield* closeActiveAssistantSegment({
          queue,
          assistantSegmentRef,
        });
        const { merged, decision } = yield* Ref.modify(toolCallsRef, (current) => {
          const tracked = current.get(event.toolCall.toolCallId);
          const previous = tracked?.state;
          const nextToolCall = mergeToolCallState(previous, event.toolCall);
          const decision = decideToolCallUpdateEmission({
            previous,
            next: nextToolCall,
            lastEmittedDetailLength: tracked?.lastEmittedDetailLength,
            skippedSinceEmit: tracked?.skippedSinceEmit ?? 0,
          });
          const next = new Map(current);
          if (nextToolCall.status === "completed" || nextToolCall.status === "failed") {
            next.delete(nextToolCall.toolCallId);
          } else {
            next.set(nextToolCall.toolCallId, {
              state: nextToolCall,
              lastEmittedDetailLength: decision.emit
                ? nextToolCall.detail?.length
                : tracked?.lastEmittedDetailLength,
              skippedSinceEmit: decision.skippedSinceEmit,
            });
          }
          return [{ merged: nextToolCall, decision }, next] as const;
        });
        if (!decision.emit) {
          continue;
        }
        yield* Queue.offer(queue, {
          _tag: "ToolCallUpdated",
          toolCall: merged,
          rawPayload: event.rawPayload,
        });
        continue;
      }
      if (event._tag === "ContentDelta") {
        if (event.text.trim().length === 0) {
          const assistantSegmentState = yield* Ref.get(assistantSegmentRef);
          if (!assistantSegmentState.activeItemId) {
            continue;
          }
        }
        const itemId = yield* ensureActiveAssistantSegment({
          queue,
          assistantSegmentRef,
          sessionId: params.sessionId,
          assistantItemRuntimeId,
        });
        yield* Queue.offer(queue, {
          ...event,
          itemId,
        });
        continue;
      }
      yield* Queue.offer(queue, event);
    }
  });

export function updateModeState(
  modeState: AcpSessionModeState,
  nextModeId: string,
): AcpSessionModeState {
  const normalized = nextModeId.trim();
  if (!normalized) {
    return modeState;
  }
  return modeState.availableModes.some((mode) => mode.id === normalized)
    ? {
        ...modeState,
        currentModeId: normalized,
      }
    : modeState;
}

export const assistantItemId = (sessionId: string, runtimeId: string, segmentIndex: number) =>
  `assistant:${sessionId}:runtime:${runtimeId}:segment:${segmentIndex}`;

export const ensureActiveAssistantSegment = ({
  queue,
  assistantSegmentRef,
  sessionId,
  assistantItemRuntimeId,
}: {
  readonly queue: Queue.Queue<AcpSessionRuntimeEvent>;
  readonly assistantSegmentRef: Ref.Ref<AcpAssistantSegmentState>;
  readonly sessionId: string;
  readonly assistantItemRuntimeId: string;
}) =>
  Ref.modify<AcpAssistantSegmentState, EnsureActiveAssistantSegmentResult>(
    assistantSegmentRef,
    (current) => {
      if (current.activeItemId) {
        return [{ itemId: current.activeItemId }, current] as const;
      }
      const itemId = assistantItemId(sessionId, assistantItemRuntimeId, current.nextSegmentIndex);
      return [
        {
          itemId,
          startedEvent: {
            _tag: "AssistantItemStarted",
            itemId,
          } satisfies Extract<AcpParsedSessionEvent, { readonly _tag: "AssistantItemStarted" }>,
        },
        {
          nextSegmentIndex: current.nextSegmentIndex + 1,
          activeItemId: itemId,
        } satisfies AcpAssistantSegmentState,
      ] as const;
    },
  ).pipe(
    Effect.flatMap((result) =>
      result.startedEvent
        ? Queue.offer(queue, result.startedEvent).pipe(Effect.as(result.itemId))
        : Effect.succeed(result.itemId),
    ),
  );

export const closeActiveAssistantSegment = ({
  queue,
  assistantSegmentRef,
}: {
  readonly queue: Queue.Queue<AcpSessionRuntimeEvent>;
  readonly assistantSegmentRef: Ref.Ref<AcpAssistantSegmentState>;
}) =>
  Ref.modify(assistantSegmentRef, (current) => {
    if (!current.activeItemId) {
      return [undefined, current] as const;
    }
    return [
      {
        _tag: "AssistantItemCompleted",
        itemId: current.activeItemId,
      } satisfies AcpParsedSessionEvent,
      {
        nextSegmentIndex: current.nextSegmentIndex,
      } satisfies AcpAssistantSegmentState,
    ] as const;
  }).pipe(Effect.flatMap((event) => (event ? Queue.offer(queue, event) : Effect.void)));
