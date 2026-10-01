import * as NodeServices from "@effect/platform-node/NodeServices";

import { assert, describe, it } from "@effect/vitest";

import * as Effect from "effect/Effect";

import {
  checkPortAvailabilityOnHosts,
  devPortProbeHosts,
  isBrowserAllowedPort,
  resolveModePortOffsets,
} from "./dev-runner.ts";

it.layer(NodeServices.layer)("dev-runner", (it) => {
  describe("isBrowserAllowedPort", () => {
    it.each([6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697])(
      "rejects Fetch-blocked web port %s from the worktree offset range",
      (port) => {
        assert.equal(isBrowserAllowedPort(port), false);
      },
    );

    it.each([5733, 5900, 6567, 6670, 8733])("allows browser-safe web port %s", (port) => {
      assert.equal(isBrowserAllowedPort(port), true);
    });
  });

  describe("checkPortAvailabilityOnHosts", () => {
    it.effect("checks overlapping hosts sequentially to avoid self-interference", () =>
      Effect.gen(function* () {
        let inFlightCount = 0;
        const calls: Array<[number, string]> = [];

        const available = yield* checkPortAvailabilityOnHosts(
          13_773,
          ["127.0.0.1", "0.0.0.0", "::"],
          (port, host) =>
            Effect.promise(async () => {
              calls.push([port, host]);
              inFlightCount += 1;
              const overlapped = inFlightCount > 1;
              await Promise.resolve();
              inFlightCount -= 1;

              return !overlapped;
            }),
        );

        assert.equal(available, true);
        assert.deepStrictEqual(calls, [
          [13_773, "127.0.0.1"],
          [13_773, "0.0.0.0"],
          [13_773, "::"],
        ]);
      }),
    );
  });

  describe("devPortProbeHosts", () => {
    it.effect("probes loopback only when no bind host is configured", () =>
      Effect.sync(() => {
        assert.deepStrictEqual(devPortProbeHosts(undefined), ["127.0.0.1", "::1"]);
        assert.deepStrictEqual(devPortProbeHosts("  "), ["127.0.0.1", "::1"]);
      }),
    );

    // A port free on loopback can be taken on the interface the server will
    // actually bind, so --host/T3CODE_HOST has to be probed as well.
    it.effect("adds a non-loopback bind host to the probe list", () =>
      Effect.sync(() => {
        assert.deepStrictEqual(devPortProbeHosts("0.0.0.0"), ["127.0.0.1", "::1", "0.0.0.0"]);
        assert.deepStrictEqual(devPortProbeHosts("192.168.1.10"), [
          "127.0.0.1",
          "::1",
          "192.168.1.10",
        ]);
      }),
    );

    it.effect("does not probe loopback twice when it is the configured host", () =>
      Effect.sync(() => {
        assert.deepStrictEqual(devPortProbeHosts("127.0.0.1"), ["127.0.0.1", "::1"]);
      }),
    );

    // Only the backend honours --host/T3CODE_HOST. Vite reads HOST (set for
    // desktop only), so judging the web port against the backend's interface
    // would reject ports for a server that never binds there.
    it.effect("passes the port role so only the server port sees the bind host", () =>
      Effect.gen(function* () {
        const probed: Array<{ port: number; role: string | undefined }> = [];

        yield* resolveModePortOffsets({
          mode: "dev",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          checkPortAvailability: (port, role) => {
            probed.push({ port, role });

            return Effect.succeed(true);
          },
        });

        assert.deepStrictEqual(probed, [
          { port: 13_773, role: "server" },
          { port: 5733, role: "web" },
        ]);
      }),
    );
  });

  describe("resolveModePortOffsets", () => {
    it.effect("uses a shared fallback offset for dev mode", () =>
      Effect.gen(function* () {
        const taken = new Set([13773, 5733]);

        const offsets = yield* resolveModePortOffsets({
          mode: "dev",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 1, webOffset: 1 });
      }),
    );

    it.effect("keeps server offset stable for dev:web and only shifts web offset", () =>
      Effect.gen(function* () {
        const taken = new Set([5733]);

        const offsets = yield* resolveModePortOffsets({
          mode: "dev:web",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 0, webOffset: 1 });
      }),
    );

    it.effect("shifts only server offset for dev:server", () =>
      Effect.gen(function* () {
        const taken = new Set([13773]);

        const offsets = yield* resolveModePortOffsets({
          mode: "dev:server",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 1, webOffset: 1 });
      }),
    );

    it.effect("respects explicit dev-url override for dev:web", () =>
      Effect.gen(function* () {
        const offsets = yield* resolveModePortOffsets({
          mode: "dev:web",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: true,
          checkPortAvailability: () => Effect.succeed(false),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 0, webOffset: 0 });
      }),
    );

    it.effect("respects explicit server port override for dev:server", () =>
      Effect.gen(function* () {
        const offsets = yield* resolveModePortOffsets({
          mode: "dev:server",
          startOffset: 0,
          hasExplicitServerPort: true,
          hasExplicitDevUrl: false,
          checkPortAvailability: () => Effect.succeed(false),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 0, webOffset: 0 });
      }),
    );
  });
});
