// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises Node HTTP and filesystem boundaries.
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { cli } from "../bin.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
  type PersistedServerRuntimeState,
} from "../serverRuntimeState.ts";
import {
  AdminAlreadyPairedError,
  DevServerNotProxiableError,
  InvalidPublicUrlError,
  issueAdminPairingLink,
  PairStdoutIsTerminal,
  parsePublicPairingBaseUrl,
  resolveDirectPairingBaseUrl,
  resolveTailscaleLocalTarget,
} from "./pair.ts";

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

const baseState = {
  version: 1,
  pid: 123,
  port: 3_773,
  origin: "http://127.0.0.1:3773",
  startedAt: "2026-06-20T00:00:00.000Z",
} as const satisfies PersistedServerRuntimeState;

describe("pair base URL selection", () => {
  it("pairs through the dev web origin when the server fronts a dev server", () => {
    expect(resolveDirectPairingBaseUrl({ ...baseState, devUrl: "http://localhost:5733/" })).toBe(
      "http://localhost:5733/",
    );
  });

  it("pairs through the bound host when there is no dev server", () => {
    expect(resolveDirectPairingBaseUrl({ ...baseState, host: "100.64.0.7" })).toBe(
      "http://100.64.0.7:3773",
    );
    expect(resolveDirectPairingBaseUrl(baseState)).toBe("http://localhost:3773");
  });
});

describe("pair public URL", () => {
  it("accepts an http or https origin", () => {
    expect(parsePublicPairingBaseUrl("https://akeru.example.com")).toBe(
      "https://akeru.example.com",
    );
    expect(parsePublicPairingBaseUrl("https://akeru.example.com:8443/")).toBe(
      "https://akeru.example.com:8443",
    );
    expect(parsePublicPairingBaseUrl("http://192.168.1.10:3773")).toBe("http://192.168.1.10:3773");
  });

  it("rejects anything that is not a bare http or https origin", () => {
    for (const raw of [
      "akeru.example.com",
      "ftp://akeru.example.com",
      "javascript:alert(1)",
      "https://user:pass@akeru.example.com",
      "https://akeru.example.com/akeru",
      "https://akeru.example.com/?token=abc",
    ]) {
      expect(parsePublicPairingBaseUrl(raw)).toBeInstanceOf(InvalidPublicUrlError);
    }
  });
});

const InMemoryEnvironmentAuthLayer = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.identityLayer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-pair-admin-test-" })),
  Layer.provide(NodeServices.layer),
);

describe("pair admin link", () => {
  it.effect("is offered until a person pairs an admin client, then refused", () =>
    Effect.gen(function* () {
      const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const noOverrides = { ttl: Option.none(), label: Option.none() };

      // CLI bearer sessions for bots and scripts do not close the admin bootstrap.
      yield* environmentAuth.issueSession({ label: "script" });
      const issued = yield* issueAdminPairingLink(noOverrides);
      expect(issued.scopes).toContain("access:write");

      yield* environmentAuth.exchangeBootstrapCredentialForAccessToken(
        issued.credential,
        undefined,
        { deviceType: "mobile" },
      );
      const refused = yield* issueAdminPairingLink(noOverrides).pipe(Effect.flip);

      expect(refused).toBeInstanceOf(AdminAlreadyPairedError);
    }).pipe(Effect.provide(InMemoryEnvironmentAuthLayer)),
  );
});

describe("pair tailscale local target", () => {
  it("proxies the dev web port for dev servers", () => {
    expect(resolveTailscaleLocalTarget({ ...baseState, devUrl: "http://localhost:5733/" })).toEqual(
      { localPort: 5_733 },
    );
    // A dev server on a non-loopback interface must be proxied at that
    // interface; tailscale serve defaults to 127.0.0.1 otherwise.
    expect(
      resolveTailscaleLocalTarget({ ...baseState, devUrl: "http://192.168.1.10:5733/" }),
    ).toEqual({ localPort: 5_733, localHost: "192.168.1.10" });
    // URL.hostname keeps IPv6 brackets, so the serve target stays valid.
    expect(
      resolveTailscaleLocalTarget({ ...baseState, devUrl: "http://[fd7a:115c::1]:5733/" }),
    ).toEqual({ localPort: 5_733, localHost: "[fd7a:115c::1]" });
  });

  it("rejects HTTPS dev URLs, which tailscale serve cannot proxy", () => {
    expect(
      resolveTailscaleLocalTarget({ ...baseState, devUrl: "https://localhost:5733/" }),
    ).toBeInstanceOf(DevServerNotProxiableError);
  });

  it("proxies the backend port directly otherwise", () => {
    expect(resolveTailscaleLocalTarget(baseState)).toEqual({ localPort: 3_773 });
    expect(resolveTailscaleLocalTarget({ ...baseState, host: "0.0.0.0" })).toEqual({
      localPort: 3_773,
    });
    expect(resolveTailscaleLocalTarget({ ...baseState, host: "192.168.1.42" })).toEqual({
      localPort: 3_773,
      localHost: "192.168.1.42",
    });
  });
});

const runCli = (args: ReadonlyArray<string>) => Command.runWith(cli, { version: "0.0.0" })(args);

const provideCliTestLayers = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provide(effect, Layer.mergeAll(CliRuntimeLayer, TestConsole.layer));

// Console output accumulates across CLI runs within a test, and each
// Console.log call is one entry — so the latest command's output is the last
// entry, even when it spans many lines.
const captureStdout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  provideCliTestLayers(
    Effect.gen(function* () {
      yield* effect;
      return (
        (yield* TestConsole.logLines).findLast(
          (line): line is string => typeof line === "string",
        ) ?? ""
      );
    }),
  );

const testDescriptor = {
  environmentId: "pair-test-environment",
  label: "pair-test",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.1",
  capabilities: { repositoryIdentity: true },
};

const withDescriptorServer = <A, E, R>(run: (origin: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.callback<NodeHttp.Server>((resume) => {
      const server = NodeHttp.createServer((request, response) => {
        if (request.url === "/.well-known/t3/environment") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(testDescriptor));
          return;
        }
        response.writeHead(404);
        response.end();
      });
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        return Effect.die(new Error("Expected a TCP address"));
      }
      return run(`http://127.0.0.1:${String(address.port)}`);
    },
    (server) => Effect.sync(() => server.close()),
  );

describe("akeru pair", () => {
  it.effect("mints a token and prints a QR pairing URL for a live server", () =>
    withDescriptorServer((origin) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pair-test-"));
        const port = Number(new URL(origin).port);
        const statePath = NodePath.join(baseDir, "userdata", "server-runtime.json");
        yield* persistServerRuntimeState({
          path: statePath,
          state: yield* makePersistedServerRuntimeState({
            config: { host: "127.0.0.1", devUrl: undefined },
            port,
          }),
        });

        const output = yield* captureStdout(runCli(["pair", "--base-dir", baseDir])).pipe(
          Effect.provideService(PairStdoutIsTerminal, true),
        );

        assert.include(output, `Pairing with pair-test (${origin})`);
        assert.include(output, `Pairing URL: ${origin}/pair#token=`);
        assert.isTrue(output.includes("█") || output.includes("▀") || output.includes("▄"));
        // Loopback origins are not reachable from a phone; the output must say so.
        assert.include(output, "only reachable from this machine");

        const token = /#token=([A-Z2-9]+)/.exec(output)?.[1];
        assert.isString(token);

        // The token must be in the same store the running server reads.
        const listed = yield* captureStdout(
          runCli(["auth", "pairing", "list", "--base-dir", baseDir, "--json"]),
        );
        // @effect-diagnostics-next-line preferSchemaOverJson:off - CLI JSON output is decoded as a presentation DTO.
        const credentials = JSON.parse(listed) as ReadonlyArray<{ readonly label?: string }>;
        assert.equal(credentials.length, 1);
        assert.equal(credentials[0]?.label, "akeru pair");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("prints the QR code only on a terminal and never with --no-qr", () =>
    withDescriptorServer((origin) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pair-qr-test-"));
        yield* persistServerRuntimeState({
          path: NodePath.join(baseDir, "userdata", "server-runtime.json"),
          state: yield* makePersistedServerRuntimeState({
            config: { host: "127.0.0.1", devUrl: undefined },
            port: Number(new URL(origin).port),
          }),
        });
        const hasQrCode = (output: string) => /[█▀▄]/.test(output);

        const onTerminal = yield* captureStdout(runCli(["pair", "--base-dir", baseDir])).pipe(
          Effect.provideService(PairStdoutIsTerminal, true),
        );
        const optedOut = yield* captureStdout(
          runCli(["pair", "--base-dir", baseDir, "--no-qr"]),
        ).pipe(Effect.provideService(PairStdoutIsTerminal, true));
        const piped = yield* captureStdout(runCli(["pair", "--base-dir", baseDir])).pipe(
          Effect.provideService(PairStdoutIsTerminal, false),
        );

        assert.isTrue(hasQrCode(onTerminal));
        for (const output of [optedOut, piped]) {
          assert.isFalse(hasQrCode(output));
          // The full URL with its token is always printed, QR code or not.
          assert.match(output, /Pairing URL: http:\/\/127\.0\.0\.1:\d+\/pair#token=[A-Z2-9]+/);
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("builds the pairing URL on --public-url for a loopback server behind a tunnel", () =>
    withDescriptorServer((origin) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pair-public-test-"));
        yield* persistServerRuntimeState({
          path: NodePath.join(baseDir, "userdata", "server-runtime.json"),
          state: yield* makePersistedServerRuntimeState({
            config: { host: "127.0.0.1", devUrl: undefined },
            port: Number(new URL(origin).port),
          }),
        });

        const output = yield* captureStdout(
          runCli(["pair", "--base-dir", baseDir, "--public-url", "https://akeru.example.com"]),
        );

        assert.match(output, /Pairing URL: https:\/\/akeru\.example\.com\/pair#token=[A-Z2-9]+/);
        assert.notInclude(output, "only reachable from this machine");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a non-http --public-url and --public-url with --tailscale", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pair-public-bad-"));
      const render = (error: unknown) =>
        String(
          typeof error === "object" && error !== null && "cause" in error ? error.cause : error,
        );

      const badScheme = yield* provideCliTestLayers(
        runCli(["pair", "--base-dir", baseDir, "--public-url", "ftp://example.com"]).pipe(
          Effect.flip,
        ),
      );
      const both = yield* provideCliTestLayers(
        runCli([
          "pair",
          "--base-dir",
          baseDir,
          "--public-url",
          "https://example.com",
          "--tailscale",
        ]).pipe(Effect.flip),
      );

      assert.include(render(badScheme), "must use http or https");
      assert.include(render(both), "not both");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("mints an admin-scope link with --admin and says so", () =>
    withDescriptorServer((origin) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pair-admin-cli-"));
        yield* persistServerRuntimeState({
          path: NodePath.join(baseDir, "userdata", "server-runtime.json"),
          state: yield* makePersistedServerRuntimeState({
            config: { host: "127.0.0.1", devUrl: undefined },
            port: Number(new URL(origin).port),
          }),
        });

        const output = yield* captureStdout(runCli(["pair", "--base-dir", baseDir, "--admin"]));
        const listed = yield* captureStdout(
          runCli(["auth", "pairing", "list", "--base-dir", baseDir, "--json"]),
        );

        assert.include(output, "grants admin scope");
        assert.match(output, /Pairing URL: http:\/\/127\.0\.0\.1:\d+\/pair#token=[A-Z2-9]+/);
        // @effect-diagnostics-next-line preferSchemaOverJson:off - CLI JSON output is decoded as a presentation DTO.
        const credentials = JSON.parse(listed) as ReadonlyArray<{
          readonly label?: string;
          readonly scopes: ReadonlyArray<string>;
        }>;
        assert.equal(credentials.length, 1);
        assert.equal(credentials[0]?.label, "akeru pair --admin");
        assert.include(credentials[0]?.scopes ?? [], "access:write");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("pairs through the recorded dev web URL for dev servers", () =>
    withDescriptorServer((origin) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pair-dev-test-"));
        const port = Number(new URL(origin).port);
        const statePath = NodePath.join(baseDir, "dev", "server-runtime.json");
        yield* persistServerRuntimeState({
          path: statePath,
          state: yield* makePersistedServerRuntimeState({
            config: { host: undefined, devUrl: new URL("http://localhost:5733") },
            port,
          }),
        });

        const output = yield* captureStdout(runCli(["pair", "--base-dir", baseDir]));

        assert.include(output, "Pairing URL: http://localhost:5733/pair#token=");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("directs to akeru serve when no server is running", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pair-none-test-"));

      const error = yield* provideCliTestLayers(
        runCli(["pair", "--base-dir", baseDir]).pipe(Effect.flip),
      );

      const rendered = String(
        typeof error === "object" && error !== null && "cause" in error ? error.cause : error,
      );
      assert.include(rendered, "No running Akeru Bot server found.");
      assert.include(rendered, "npx akeru-bot serve");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("ignores runtime state whose recorded pid is no longer alive", () =>
    withDescriptorServer((origin) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pair-pid-test-"));
        const statePath = NodePath.join(baseDir, "userdata", "server-runtime.json");
        // The origin answers (another server reused the port), but the pid
        // that wrote this state file is dead — pairing must not mint a token
        // into the dead server's database.
        const state = yield* makePersistedServerRuntimeState({
          config: { host: "127.0.0.1", devUrl: undefined },
          port: Number(new URL(origin).port),
        });
        yield* persistServerRuntimeState({
          path: statePath,
          // pid 2**22 + 1 exceeds any default Linux/macOS pid range.
          state: { ...state, pid: 4_194_305 },
        });

        const error = yield* provideCliTestLayers(
          runCli(["pair", "--base-dir", baseDir]).pipe(Effect.flip),
        );

        const rendered = String(
          typeof error === "object" && error !== null && "cause" in error ? error.cause : error,
        );
        assert.include(rendered, "No running Akeru Bot server found.");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("ignores stale runtime state pointing at a dead server", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pair-stale-test-"));
      const statePath = NodePath.join(baseDir, "userdata", "server-runtime.json");
      // A port from the dynamic range with nothing listening: the probe fails
      // fast with ECONNREFUSED and discovery moves on.
      yield* persistServerRuntimeState({
        path: statePath,
        state: yield* makePersistedServerRuntimeState({
          config: { host: "127.0.0.1", devUrl: undefined },
          port: 1,
        }),
      });

      const error = yield* provideCliTestLayers(
        runCli(["pair", "--base-dir", baseDir]).pipe(Effect.flip),
      );

      const rendered = String(
        typeof error === "object" && error !== null && "cause" in error ? error.cause : error,
      );
      assert.include(rendered, "No running Akeru Bot server found.");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
