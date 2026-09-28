import type { SupervisorConnectionState } from "@t3tools/client-runtime/connection";

import type { Bot } from "./types";

export type RoutedBotResolution =
  | { readonly status: "loading" }
  | { readonly status: "missing" }
  | { readonly status: "available"; readonly bot: Bot };

/** A route may judge a bot id only after the store mirrors the active environment. */
export function resolveRoutedBot(
  environmentId: string | null,
  rosterEnvironmentId: string | null,
  bots: readonly Bot[],
  botId: string,
): RoutedBotResolution {
  if (environmentId === null || rosterEnvironmentId !== environmentId) {
    return { status: "loading" };
  }

  const bot = bots.find((candidate) => candidate.id === botId && candidate.archivedAt === null);
  return bot ? { status: "available", bot } : { status: "missing" };
}

/**
 * What the roster list shows. Until the store mirrors the active environment
 * the list stays blank, so a roster that has not arrived never claims "No bots yet".
 */
export function resolveRosterListState(
  environmentId: string | null,
  rosterEnvironmentId: string | null,
  bots: readonly Pick<Bot, "archivedAt">[],
): "loading" | "empty" | "bots" {
  if (!isRosterReady(environmentId, rosterEnvironmentId)) return "loading";
  return bots.every((bot) => bot.archivedAt !== null) ? "empty" : "bots";
}

export function isRosterReady(
  environmentId: string | null,
  rosterEnvironmentId: string | null,
): boolean {
  return environmentId !== null && rosterEnvironmentId === environmentId;
}

export type RosterLoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string };

const ROSTER_LOADING: RosterLoadState = { kind: "loading" };
const ROSTER_UNREACHABLE_MESSAGE = "The environment is not reachable.";

/**
 * Why the roster has not arrived. A failed first snapshot or a connection
 * that stopped trying reads as a failure the user can retry. A retrying
 * connection gets its first two attempts before it counts as failed, matching
 * the landing's bootstrap gate.
 */
export function resolveRosterLoadState(input: {
  readonly shellError: string | null;
  readonly connection: Pick<SupervisorConnectionState, "phase" | "attempt" | "lastFailure"> | null;
}): RosterLoadState {
  if (input.shellError !== null) return { kind: "failed", message: input.shellError };
  const connection = input.connection;
  if (connection === null) return ROSTER_LOADING;
  const failed = (): RosterLoadState => ({
    kind: "failed",
    message: connection.lastFailure?.message ?? ROSTER_UNREACHABLE_MESSAGE,
  });
  switch (connection.phase) {
    case "blocked":
    case "offline":
      return failed();
    case "backoff":
      return connection.attempt > 2 ? failed() : ROSTER_LOADING;
    default:
      return ROSTER_LOADING;
  }
}
