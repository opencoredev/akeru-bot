import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import { renderTerminalQrCode } from "../startupAccess.ts";

/**
 * Whether stdout is a terminal. A QR code piped into a file or another program is only noise, so
 * `akeru pair` prints it only when this is true. Tests override it.
 */
export const PairStdoutIsTerminal = Context.Reference<boolean>(
  "akeru-bot/cli/pair/StdoutIsTerminal",
  { defaultValue: () => process.stdout.isTTY === true },
);

export const formatPairOutput = (input: {
  readonly serverLabel: string;
  readonly origin: string;
  readonly pairingUrl: string;
  readonly token: string;
  readonly expiresAt: DateTime.Utc;
  readonly notes: ReadonlyArray<string>;
  readonly qrCode: boolean;
}): string =>
  [
    `Pairing with ${input.serverLabel} (${input.origin}).`,
    "",
    ...(input.qrCode ? [renderTerminalQrCode(input.pairingUrl), ""] : []),
    `Pairing URL: ${input.pairingUrl}`,
    `Token: ${input.token}`,
    `Expires: ${DateTime.formatIso(input.expiresAt)}`,
    ...input.notes.flatMap((note) => ["", `Note: ${note}`]),
    "",
  ].join("\n");
