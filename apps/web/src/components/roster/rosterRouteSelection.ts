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

export function isRosterReady(
  environmentId: string | null,
  rosterEnvironmentId: string | null,
): boolean {
  return environmentId !== null && rosterEnvironmentId === environmentId;
}
