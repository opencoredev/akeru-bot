import {
  type EnvironmentId,
  type ServerLifecycleStreamReadyEvent,
  type ServerSelfUpdateProgressEvent,
  type ServerSelfUpdateResult,
} from "@akeru/contracts";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";
import { isRpcClientError } from "../rpc/client.ts";
import { type ServerUpdateState } from "./serverTypes.ts";

export const IDLE_SERVER_UPDATE_STATE: ServerUpdateState = { status: "idle" };

export const EMPTY_SERVER_UPDATE_STATE_ATOM = Atom.make<ServerUpdateState>(
  IDLE_SERVER_UPDATE_STATE,
).pipe(Atom.withLabel("environment-data:server:update-state:empty"));

export const serverUpdateStateAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make<ServerUpdateState>(IDLE_SERVER_UPDATE_STATE).pipe(
    Atom.withLabel(`environment-data:server:update-state:${environmentId}`),
  ),
);

export class ServerUpdateResumeTimeoutError extends Schema.TaggedErrorClass<ServerUpdateResumeTimeoutError>()(
  "ServerUpdateResumeTimeoutError",
  {
    environmentId: Schema.String,
    targetVersion: Schema.String,
  },
) {
  override get message(): string {
    return `The server did not resume on Akeru Bot ${this.targetVersion}.`;
  }
}

export class ServerUpdateProgressIncompleteError extends Schema.TaggedErrorClass<ServerUpdateProgressIncompleteError>()(
  "ServerUpdateProgressIncompleteError",
  {
    targetVersion: Schema.String,
  },
) {
  override get message(): string {
    return `The Akeru Bot ${this.targetVersion} update ended before the server accepted the restart.`;
  }
}

export class ServerUpdateTerminalError extends Schema.TaggedErrorClass<ServerUpdateTerminalError>()(
  "ServerUpdateTerminalError",
  {
    targetVersion: Schema.String,
    status: Schema.Literals(["committed", "rolled-back", "failed"]),
    reason: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return this.reason ?? `The Akeru Bot ${this.targetVersion} update ${this.status}.`;
  }
}

// Covers the 120-second trial deadline and a final restart of the previous
// version when the trial rolls back.
export const SERVER_UPDATE_RESUME_TIMEOUT = Duration.minutes(4);

export function matchesServerUpdateReadyEvent(
  result: ServerSelfUpdateResult,
  event: ServerLifecycleStreamReadyEvent,
): boolean {
  return result.updateId === undefined
    ? event.payload.environment.serverVersion === result.targetVersion
    : event.payload.updateOutcome?.id === result.updateId;
}

export function validateServerUpdateReadyEvent(
  result: ServerSelfUpdateResult,
  event: ServerLifecycleStreamReadyEvent,
): Effect.Effect<void, ServerUpdateTerminalError> {
  if (result.updateId === undefined) return Effect.void;
  const outcome = event.payload.updateOutcome;
  if (
    outcome?.id === result.updateId &&
    outcome.status === "committed" &&
    outcome.targetVersion === result.targetVersion &&
    event.payload.environment.serverVersion === result.targetVersion
  ) {
    return Effect.void;
  }
  return Effect.fail(
    new ServerUpdateTerminalError({
      targetVersion: result.targetVersion,
      status: outcome?.status ?? "failed",
      reason:
        outcome?.reason ??
        "The service launcher resumed without committing the requested server version.",
    }),
  );
}

/**
 * Keeps reconnect attempts ~1s apart for the whole update restart.
 *
 * A restart takes the server down for ~15 seconds, but the supervisor's normal
 * backoff ladder (1/2/4/8/16s) assumes an unexpected failure and lands attempts
 * at ~3, 5, 9, 17 and 33 seconds — so a 15-second restart is observed as a
 * 33-second "Resuming". Nudging on every backoff entry (not just the first)
 * holds the retry cadence flat until the server answers again. The sleep before
 * each nudge is the pacer: a connection that fails instantly re-enters backoff
 * immediately and would otherwise spin a tight retry loop.
 *
 * A newly restarted server can also reject the first environment credential.
 * Authentication blocks need the same paced retry during this known restart;
 * permission and configuration failures remain blocked.
 *
 * Callers fork this as a child of the update command so it is interrupted as
 * soon as the update settles, whether it succeeds, fails, or times out.
 */
export function nudgeReconnectDuringUpdateRestart(input: {
  readonly stateChanges: Stream.Stream<
    {
      readonly phase: string;
      readonly lastFailure?: { readonly reason: string } | null;
    },
    unknown
  >;
  readonly retryNow: Effect.Effect<void>;
  readonly interval?: Duration.Duration;
}): Effect.Effect<void> {
  return input.stateChanges.pipe(
    Stream.filter(
      (state) =>
        state.phase === "backoff" ||
        (state.phase === "blocked" && state.lastFailure?.reason === "authentication"),
    ),
    Stream.runForEach(() =>
      Effect.sleep(input.interval ?? Duration.seconds(1)).pipe(Effect.andThen(input.retryNow)),
    ),
    Effect.timeoutOption(SERVER_UPDATE_RESUME_TIMEOUT),
    Effect.ignore,
  );
}

export function serverUpdateStateForProgressEvent(
  fromVersion: string,
  targetVersion: string,
  event: ServerSelfUpdateProgressEvent,
): Extract<ServerUpdateState, { status: "running" }> {
  return {
    status: "running",
    stage: event.type === "complete" ? "resuming" : event.stage,
    fromVersion,
    targetVersion,
  };
}

export function serverUpdateStateForServerVersion(
  state: ServerUpdateState,
  serverVersion: string | null,
): ServerUpdateState {
  return state.status === "idle" ||
    state.status === "running" ||
    serverVersion === null ||
    state.fromVersion === serverVersion
    ? state
    : IDLE_SERVER_UPDATE_STATE;
}

export function serverUpdateFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Server update failed.";
}

function isRpcSocketError(error: unknown): boolean {
  if (!isRpcClientError(error)) {
    return false;
  }
  switch (error.reason._tag) {
    case "SocketReadError":
    case "SocketWriteError":
    case "SocketCloseError":
      return true;
    default:
      return false;
  }
}

export function isLegacyUpdateHandoffLoss(cause: Cause.Cause<unknown>): boolean {
  if (Cause.hasInterruptsOnly(cause)) {
    return true;
  }
  return (
    cause.reasons.length > 0 &&
    cause.reasons.every((reason) => Cause.isFailReason(reason) && isRpcSocketError(reason.error))
  );
}

export function resolveServerUpdateProgressResult<E>(
  targetVersion: string,
  terminal: Option.Option<ServerSelfUpdateResult>,
  streamExit: Exit.Exit<void, E>,
): Effect.Effect<ServerSelfUpdateResult, E | ServerUpdateProgressIncompleteError> {
  if (
    Option.isSome(terminal) &&
    (Exit.isSuccess(streamExit) || isLegacyUpdateHandoffLoss(streamExit.cause))
  ) {
    return Effect.succeed(terminal.value);
  }
  if (Exit.isFailure(streamExit)) {
    return Effect.failCause(streamExit.cause);
  }
  return Effect.fail(new ServerUpdateProgressIncompleteError({ targetVersion }));
}
