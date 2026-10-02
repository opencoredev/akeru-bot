import * as Match from "effect/Match";
import { ProviderRuntimeEvent } from "@akeru/contracts";
import * as Schema from "effect/Schema";

interface FixtureIds {
  readonly eventId: string;
  readonly sessionId?: string | undefined;
  readonly provider: ProviderRuntimeEvent["provider"];
  readonly createdAt: string;
  readonly threadId?: string | undefined;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
}

type CanonicalFixtureEvent = {
  [Type in ProviderRuntimeEvent["type"]]: Omit<
    Extract<ProviderRuntimeEvent, { type: Type }>,
    keyof FixtureIds
  > &
    FixtureIds;
}[ProviderRuntimeEvent["type"]];

type LegacyFixtureEvent = FixtureIds &
  (
    | {
        readonly type: "session.started" | "thread.started" | "session.exited";
        readonly payload?: undefined;
        readonly message?: string;
      }
    | { readonly type: "turn.started"; readonly payload?: undefined }
    | {
        readonly type: "turn.completed";
        readonly payload?: undefined;
        readonly status: "completed" | "failed" | "interrupted" | "cancelled";
        readonly errorMessage?: string;
      }
    | { readonly type: "message.delta"; readonly delta: string }
    | { readonly type: "message.completed"; readonly detail?: string }
    | {
        readonly type: "tool.started" | "tool.completed";
        readonly toolKind?: "command" | "file-change" | "unknown";
        readonly title?: string;
        readonly detail?: string;
      }
    | {
        readonly type: "approval.requested";
        readonly requestKind: "command" | "file-change" | "unknown";
        readonly detail?: string;
      }
    | {
        readonly type: "approval.resolved";
        readonly requestKind: "command" | "file-change" | "unknown";
        readonly decision?: string;
      }
  );

export type FixtureProviderRuntimeEvent = CanonicalFixtureEvent | LegacyFixtureEvent;

export type LegacyProviderRuntimeEvent = FixtureProviderRuntimeEvent;

const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent, {
  onExcessProperty: "preserve",
});

function requestType(kind: "command" | "file-change" | "unknown") {
  return Match.value(kind).pipe(
    Match.when("command", () => "command_execution_approval"),
    Match.when("file-change", () => "file_change_approval"),
    Match.orElse(() => "unknown"),
  );
}

function itemType(kind: "command" | "file-change" | "unknown") {
  return Match.value(kind).pipe(
    Match.when("command", () => "command_execution"),
    Match.when("file-change", () => "file_change"),
    Match.orElse(() => "unknown"),
  );
}

export function normalizeFixtureEvent(event: FixtureProviderRuntimeEvent): ProviderRuntimeEvent {
  switch (event.type) {
    case "session.started":
    case "thread.started":
    case "session.exited":
    case "turn.started":
      return decodeRuntimeEvent({ ...event, payload: event.payload ?? {} });
    case "turn.completed":
      return decodeRuntimeEvent({
        ...event,
        payload: event.payload ?? {
          state: "status" in event ? event.status : "completed",
          ...("errorMessage" in event ? { errorMessage: event.errorMessage } : {}),
        },
      });
    case "message.delta":
      return decodeRuntimeEvent({
        ...event,
        type: "content.delta",
        payload: { streamKind: "assistant_text", delta: event.delta },
      });
    case "message.completed":
      return decodeRuntimeEvent({
        ...event,
        type: "item.completed",
        payload: {
          itemType: "assistant_message",
          ...(event.detail !== undefined ? { detail: event.detail } : {}),
        },
      });
    case "tool.started":
    case "tool.completed":
      return decodeRuntimeEvent({
        ...event,
        type: event.type === "tool.started" ? "item.started" : "item.completed",
        payload: {
          itemType: itemType(event.toolKind ?? "unknown"),
          ...(event.type === "tool.completed" ? { status: "completed" } : {}),
          ...(event.title !== undefined ? { title: event.title } : {}),
          ...(event.detail !== undefined ? { detail: event.detail } : {}),
        },
      });
    case "approval.requested":
      return decodeRuntimeEvent({
        ...event,
        type: "request.opened",
        payload: {
          requestType: requestType(event.requestKind),
          ...(event.detail !== undefined ? { detail: event.detail } : {}),
        },
      });
    case "approval.resolved":
      return decodeRuntimeEvent({
        ...event,
        type: "request.resolved",
        payload: {
          requestType: requestType(event.requestKind),
          ...(event.decision !== undefined ? { decision: event.decision } : {}),
        },
      });
    default:
      return decodeRuntimeEvent(event);
  }
}
