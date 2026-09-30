import { AuthAdministrativeScopes, AuthStandardClientScopes } from "@akeru/contracts";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { hasPairedAdminClient } from "./auth/adminClients.ts";
import {
  announceRemoteStartup,
  buildPairingUrl,
  formatHeadlessServeOutput,
  REMOTE_ALREADY_PAIRED_OUTPUT,
  renderTerminalQrCode,
  resolveHeadlessConnectionHost,
  resolveHeadlessConnectionString,
  resolveListeningPort,
} from "./startupAccess.ts";

it("prefers localhost when no explicit host is configured", () => {
  expect(resolveHeadlessConnectionHost(undefined)).toBe("localhost");
  expect(resolveHeadlessConnectionString(undefined, 3773)).toBe("http://localhost:3773");
});

it("keeps explicit bind hosts in the connection string", () => {
  expect(resolveHeadlessConnectionString("127.0.0.1", 3773)).toBe("http://127.0.0.1:3773");
  expect(resolveHeadlessConnectionString("::1", 3773)).toBe("http://[::1]:3773");
});

it("resolves wildcard hosts to a concrete external interface when one is available", () => {
  const connectionString = resolveHeadlessConnectionString("0.0.0.0", 3773, {
    en0: [
      {
        address: "192.168.1.42",
        netmask: "255.255.255.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: false,
        cidr: "192.168.1.42/24",
      },
    ],
    lo0: [
      {
        address: "127.0.0.1",
        netmask: "255.0.0.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: true,
        cidr: "127.0.0.1/8",
      },
    ],
  });

  expect(connectionString).toBe("http://192.168.1.42:3773");
});

it("prefers the actual bound port when an http server address is available", () => {
  expect(resolveListeningPort({ port: 4123 }, 3773)).toBe(4123);
  expect(resolveListeningPort("pipe", 3773)).toBe(3773);
  expect(resolveListeningPort(null, 3773)).toBe(3773);
});

it("builds a pairing URL that embeds the token in the hash", () => {
  expect(buildPairingUrl("http://192.168.1.42:3773", "PAIRCODE")).toBe(
    "http://192.168.1.42:3773/pair#token=PAIRCODE",
  );
});

it("renders terminal QR codes as a multi-line unicode block grid", () => {
  const qrCode = renderTerminalQrCode("http://192.168.1.42:3773/pair#token=PAIRCODE");

  assert.isTrue(qrCode.includes("█"));
  assert.isTrue(qrCode.split("\n").length > 10);
});

it("formats headless serve output with the connection string, token, pairing url, and qr code", () => {
  const output = formatHeadlessServeOutput({
    connectionString: "http://192.168.1.42:3773",
    token: "PAIRCODE",
    pairingUrl: "http://192.168.1.42:3773/pair#token=PAIRCODE",
  });

  expect(output).toContain("Connection string: http://192.168.1.42:3773");
  expect(output).toContain("Token: PAIRCODE");
  expect(output).toContain("Pairing URL: http://192.168.1.42:3773/pair#token=PAIRCODE");
  assert.isTrue(output.includes("█") || output.includes("▀") || output.includes("▄"));
});

const remoteAccessInfo = {
  connectionString: "http://100.64.0.7:3773",
  token: "admin-first-boot-token",
  pairingUrl: "http://100.64.0.7:3773/pair#token=admin-first-boot-token",
};

const announceWith = (sessions: Parameters<typeof hasPairedAdminClient>[0]) => {
  const printed: Array<string> = [];
  let issued = 0;
  const effect = announceRemoteStartup({
    listSessions: Effect.succeed(sessions),
    issueAccessInfo: Effect.sync(() => {
      issued += 1;
      return remoteAccessInfo;
    }),
    print: (text) => Effect.sync(() => void printed.push(text)),
  });
  return { effect, printed, issuedCount: () => issued };
};

it.effect("prints one admin pairing link on a remote first boot", () =>
  Effect.gen(function* () {
    const run = announceWith([
      // A CLI-issued bot token has admin scopes but is not a paired client.
      { scopes: [...AuthAdministrativeScopes], client: { deviceType: "bot" } },
    ]);
    yield* run.effect;
    assert.equal(run.issuedCount(), 1);
    assert.equal(run.printed.length, 1);
    const output = run.printed[0] ?? "";
    assert.equal(output.split(remoteAccessInfo.pairingUrl).length - 1, 1);
    expect(output).toContain("It grants admin scope");
    expect(output).toContain(renderTerminalQrCode(remoteAccessInfo.pairingUrl));
  }),
);

it.effect("prints no token once an admin client is paired", () =>
  Effect.gen(function* () {
    const run = announceWith([
      { scopes: [...AuthStandardClientScopes], client: { deviceType: "mobile" } },
      { scopes: [...AuthAdministrativeScopes], client: { deviceType: "desktop" } },
    ]);
    yield* run.effect;
    assert.equal(run.issuedCount(), 0);
    assert.deepEqual(run.printed, [REMOTE_ALREADY_PAIRED_OUTPUT]);
  }),
);

it("counts only non-bot sessions with access:write as paired admin clients", () => {
  expect(
    hasPairedAdminClient([
      { scopes: [...AuthStandardClientScopes], client: { deviceType: "mobile" } },
    ]),
  ).toBe(false);
  expect(
    hasPairedAdminClient([
      { scopes: [...AuthAdministrativeScopes], client: { deviceType: "unknown" } },
    ]),
  ).toBe(true);
});
