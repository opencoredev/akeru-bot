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
