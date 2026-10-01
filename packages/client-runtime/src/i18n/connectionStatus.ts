import { type MessageKey } from "./types.ts";

/** Stable connection failure codes, mirrored from the connection model. */
export type ConnectionFailureMessageCode =
  | "network"
  | "timeout"
  | "transport"
  | "endpoint-unavailable"
  | "remote-unavailable"
  | "authentication"
  | "configuration"
  | "permission"
  | "unsupported";

/** Explanatory copy for a connection failure code. Pass the result to `t`. */
export function connectionFailureMessage(code: ConnectionFailureMessageCode): MessageKey {
  switch (code) {
    case "network":
      return "The environment could not be reached. Check the network connection.";
    case "timeout":
      return "The environment took too long to respond.";
    case "transport":
      return "The connection to the environment was interrupted.";
    case "endpoint-unavailable":
      return "The environment address is not responding.";
    case "remote-unavailable":
      return "The environment is not ready to accept connections.";
    case "authentication":
      return "This device is no longer paired with the environment. Pair it again.";
    case "configuration":
      return "This connection is not set up correctly. Check its address and settings.";
    case "permission":
      return "This device does not have access to the environment.";
    case "unsupported":
      return "This environment runs a version the app does not support.";
  }
}

/**
 * Translated connection status built from the phase and stable failure code.
 * Raw diagnostics stay out of this string; show them separately.
 */
export function translateConnectionStatus(
  translateMessage: (message: MessageKey) => string,
  connection: {
    readonly phase: "available" | "offline" | "connecting" | "reconnecting" | "connected" | "error";
    readonly errorCode?: ConnectionFailureMessageCode | null;
  },
): string {
  const reason = connection.errorCode
    ? translateMessage(connectionFailureMessage(connection.errorCode))
    : null;

  switch (connection.phase) {
    case "available":
      return translateMessage("Available");
    case "offline":
      return translateMessage("Offline");
    case "connecting":
      return translateMessage("Connecting…");
    case "connected":
      return translateMessage("Connected");
    case "reconnecting":
      return reason
        ? `${translateMessage("Could not connect. Reconnecting…")} ${reason}`
        : translateMessage("Reconnecting…");
    case "error":
      return reason
        ? `${translateMessage("Connection failed.")} ${reason}`
        : translateMessage("Connection failed");
  }
}

/** The translated status plus the raw diagnostic, for surfaces with no separate error slot. */
export function translateConnectionStatusWithDiagnostic(
  translateMessage: (message: MessageKey) => string,
  connection: Parameters<typeof translateConnectionStatus>[1] & {
    readonly error?: string | null;
  },
): string {
  const status = translateConnectionStatus(translateMessage, connection);
  const failed = connection.phase === "error" || connection.phase === "reconnecting";

  return failed && connection.error ? `${status} (${connection.error})` : status;
}
