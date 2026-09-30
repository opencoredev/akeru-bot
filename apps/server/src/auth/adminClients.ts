import { AuthAccessWriteScope, type AuthClientSession } from "@akeru/contracts";

/**
 * True once a person has paired a client that can manage Connections. Bearer sessions minted by
 * the CLI for bots and scripts (`deviceType: "bot"`) do not count, so a fresh install that only
 * issued CLI tokens still offers its first admin pairing link.
 */
export const hasPairedAdminClient = (
  sessions: ReadonlyArray<Pick<AuthClientSession, "scopes" | "client">>,
): boolean =>
  sessions.some(
    (session) =>
      session.client.deviceType !== "bot" && session.scopes.includes(AuthAccessWriteScope),
  );
