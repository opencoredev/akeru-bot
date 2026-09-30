import * as NodeOS from "node:os";

import type { AuthClientSession } from "@akeru/contracts";
import { QrCode } from "@akeru/shared/qrCode";
import * as Effect from "effect/Effect";
import { HttpServer } from "effect/unstable/http";

import { ServerConfig } from "./config.ts";
import { hasPairedAdminClient } from "./auth/adminClients.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";

export interface HeadlessServeAccessInfo {
  readonly connectionString: string;
  readonly token: string;
  readonly pairingUrl: string;
}

type NetworkInterfacesMap = ReturnType<typeof NodeOS.networkInterfaces>;

export const isLoopbackHost = (host: string | undefined): boolean => {
  if (!host || host.length === 0) {
    return true;
  }

  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.startsWith("127.")
  );
};

export const isWildcardHost = (host: string | undefined): boolean =>
  host === "0.0.0.0" || host === "::" || host === "[::]";

export const formatHostForUrl = (host: string): string =>
  host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

const normalizeHost = (host: string): string =>
  host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

const isIpv4Family = (family: string | number): boolean => family === "IPv4" || family === 4;

const isIpv6Family = (family: string | number): boolean => family === "IPv6" || family === 6;

export const resolveHeadlessConnectionHost = (
  host: string | undefined,
  interfaces: NetworkInterfacesMap = NodeOS.networkInterfaces(),
): string => {
  if (!host) {
    return "localhost";
  }

  if (!isWildcardHost(host)) {
    return normalizeHost(host);
  }

  const interfaceEntries = Object.values(interfaces).flatMap((entries) => entries ?? []);
  const externalIpv4 = interfaceEntries.find(
    (entry) => !entry.internal && isIpv4Family(entry.family),
  );
  if (externalIpv4) {
    return externalIpv4.address;
  }

  const externalIpv6 = interfaceEntries.find(
    (entry) => !entry.internal && isIpv6Family(entry.family),
  );
  return externalIpv6 ? normalizeHost(externalIpv6.address) : "localhost";
};

export const resolveHeadlessConnectionString = (
  host: string | undefined,
  port: number,
  interfaces: NetworkInterfacesMap = NodeOS.networkInterfaces(),
): string => {
  const connectionHost = resolveHeadlessConnectionHost(host, interfaces);
  return `http://${formatHostForUrl(connectionHost)}:${port}`;
};

export const resolveListeningPort = (address: unknown, fallbackPort: number): number => {
  if (
    typeof address === "object" &&
    address !== null &&
    "port" in address &&
    typeof address.port === "number"
  ) {
    return address.port;
  }
  return fallbackPort;
};

export const buildPairingUrl = (connectionString: string, token: string): string => {
  const url = new URL(connectionString);
  url.pathname = "/pair";
  url.searchParams.delete("token");
  url.hash = new URLSearchParams([["token", token]]).toString();
  return url.toString();
};

export const renderTerminalQrCode = (value: string, margin = 2): string => {
  const qrCode = QrCode.encodeText(value, QrCode.Ecc.MEDIUM);
  const rows: Array<string> = [];
  const isDark = (x: number, y: number): boolean =>
    x >= 0 && x < qrCode.size && y >= 0 && y < qrCode.size && qrCode.getModule(x, y);

  for (let y = -margin; y < qrCode.size + margin; y += 2) {
    let row = "";

    for (let x = -margin; x < qrCode.size + margin; x += 1) {
      const topDark = isDark(x, y);
      const bottomDark = isDark(x, y + 1);

      row += topDark ? (bottomDark ? "█" : "▀") : bottomDark ? "▄" : " ";
    }

    rows.push(row);
  }

  return rows.join("\n");
};

export const formatHeadlessServeOutput = (accessInfo: HeadlessServeAccessInfo): string =>
  [
    "Akeru Bot server is ready.",
    `Connection string: ${accessInfo.connectionString}`,
    `Token: ${accessInfo.token}`,
    `Pairing URL: ${accessInfo.pairingUrl}`,
    "",
    renderTerminalQrCode(accessInfo.pairingUrl),
    "",
  ].join("\n");

/**
 * First-boot output for an Akeru Remote install. The link carries administrative scopes, so the
 * text says so plainly; it is printed only while no admin client has been paired.
 */
export const formatRemoteFirstBootOutput = (accessInfo: HeadlessServeAccessInfo): string =>
  [
    "Akeru Remote is ready and no admin client has been paired yet.",
    "Open this link on the phone or computer you will manage this machine from.",
    "It grants admin scope: that device can pair and revoke other clients and change Connections.",
    "It works once. Pair more devices later with `akeru pair`.",
    "",
    `Pairing URL: ${accessInfo.pairingUrl}`,
    "",
    renderTerminalQrCode(accessInfo.pairingUrl),
    "",
  ].join("\n");

export const REMOTE_ALREADY_PAIRED_OUTPUT =
  "Akeru Remote is ready. An admin client is already paired; run `akeru pair` to add a device.";

/**
 * Prints one admin pairing link when a remote install starts with no admin client paired, and a
 * token-free line otherwise. Dependencies are passed in so startup and tests share one path.
 */
export const announceRemoteStartup = <E1, E2, R1, R2>(input: {
  readonly listSessions: Effect.Effect<
    ReadonlyArray<Pick<AuthClientSession, "scopes" | "client">>,
    E1,
    R1
  >;
  readonly issueAccessInfo: Effect.Effect<HeadlessServeAccessInfo, E2, R2>;
  readonly print: (text: string) => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    if (hasPairedAdminClient(yield* input.listSessions)) {
      return yield* input.print(REMOTE_ALREADY_PAIRED_OUTPUT);
    }
    const accessInfo = yield* input.issueAccessInfo;
    yield* input.print(formatRemoteFirstBootOutput(accessInfo));
  });

export const issueHeadlessServeAccessInfo = Effect.fn("issueHeadlessServeAccessInfo")(function* () {
  const serverConfig = yield* ServerConfig;
  const httpServer = yield* HttpServer.HttpServer;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const connectionString = resolveHeadlessConnectionString(
    serverConfig.host,
    resolveListeningPort(httpServer.address, serverConfig.port),
  );
  const issued = yield* serverAuth.issueStartupPairingCredential();

  return {
    connectionString,
    token: issued.credential,
    pairingUrl: buildPairingUrl(connectionString, issued.credential),
  } satisfies HeadlessServeAccessInfo;
});
