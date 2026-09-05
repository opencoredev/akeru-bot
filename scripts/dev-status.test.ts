// @effect-diagnostics nodeBuiltinImport:off - Tests use isolated filesystem fixtures.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import { FetchHttpClient } from "effect/unstable/http";

import {
  collectDevStatus,
  describeStatusClients,
  formatDevStatus,
  probeStatusOrigin,
  resolveDevStatusHome,
  statusOrigin,
} from "./dev-status.ts";

const directories: string[] = [];
function fixture(linked = true) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-dev-status-"));
  directories.push(root);
  if (linked) {
    NodeFS.writeFileSync(NodePath.join(root, ".git"), "gitdir: /repo/.git/worktrees/status\n");
  } else {
    NodeFS.mkdirSync(NodePath.join(root, ".git"));
  }
  return root;
}

function writeRuntime(root: string, extra = {}) {
  const dir = NodePath.join(root, ".akeru", "userdata");
  NodeFS.mkdirSync(dir, { recursive: true });
  const file = NodePath.join(dir, "server-runtime.json");
  NodeFS.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      pid: 123,
      port: 15432,
      origin: "http://127.0.0.1:15432",
      devUrl: "http://localhost:6543",
      startedAt: "2026-09-04T00:00:00.000Z",
      ...extra,
    }),
  );
  return file;
}

afterEach(() => {
  for (const dir of directories.splice(0)) {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

describe("dev status home", () => {
  it.effect("uses the linked worktree ahead of ambient homes", () =>
    Effect.gen(function* () {
      const root = fixture();
      const cwd = NodePath.join(root, "scripts");
      NodeFS.mkdirSync(cwd);
      const status = yield* resolveDevStatusHome({
        cwd,
        userHome: "/users/test",
        env: { T3CODE_HOME: "/live", AKERU_HOME: "/other-live" },
      });
      expect(status).toEqual({
        worktree: root,
        home: NodePath.join(root, ".akeru"),
        dataDir: NodePath.join(root, ".akeru/userdata"),
      });
      expect(NodeFS.existsSync(status.home)).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uses dev for the implicit main checkout home", () =>
    Effect.gen(function* () {
      const root = fixture(false);
      const status = yield* resolveDevStatusHome({
        cwd: root,
        userHome: "/users/test",
        env: { AKERU_HOME: "/ignored-by-dev-runner" },
      });
      expect(status.dataDir).toBe("/users/test/.akeru/dev");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uses userdata for explicit and ambient homes", () =>
    Effect.gen(function* () {
      const root = fixture(false);
      const resolve = (homeDir?: string) =>
        resolveDevStatusHome({
          cwd: root,
          homeDir,
          userHome: "/users/test",
          env: { T3CODE_HOME: "/configured" },
        });
      expect((yield* resolve()).dataDir).toBe("/configured/userdata");
      expect((yield* resolve("local")).dataDir).toBe(NodePath.join(root, "local/userdata"));
      expect((yield* resolve("~/sandbox")).dataDir).toBe("/users/test/sandbox/userdata");
      const linked = fixture();
      const explicit = yield* resolveDevStatusHome({
        cwd: linked,
        homeDir: "/explicit",
        userHome: "/users/test",
        env: {},
      });
      expect(explicit.dataDir).toBe("/explicit/userdata");
      const blank = yield* resolveDevStatusHome({
        cwd: linked,
        homeDir: "  ",
        userHome: "/users/test",
        env: {},
      });
      expect(blank.dataDir).toBe(NodePath.join(linked, ".akeru/userdata"));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("dev status discovery", () => {
  it.effect("reports missing runtime without writes or guessed ports", () =>
    Effect.gen(function* () {
      const root = fixture();
      const probe = vi.fn(() => Effect.succeed("unexpected"));
      const status = yield* collectDevStatus({ cwd: root, env: {}, probe });
      expect(status.server.origin).toBeUndefined();
      expect(status.missing).toContain("usable server-runtime.json");
      expect(probe).not.toHaveBeenCalled();
      expect(NodeFS.readdirSync(root)).toEqual([".git"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports stale runtime and leaves the file unchanged", () =>
    Effect.gen(function* () {
      const root = fixture();
      const file = writeRuntime(root);
      const before = NodeFS.readFileSync(file, "utf8");
      const probe = vi.fn(() => Effect.succeed("unexpected"));
      const status = yield* collectDevStatus({
        cwd: root,
        env: {},
        isProcessAlive: () => false,
        probe,
      });
      expect(status.descriptor).toContain("stale");
      expect(status.server.origin).toBe("http://127.0.0.1:15432");
      expect(status.server.readiness).toContain("unavailable");
      expect(probe).not.toHaveBeenCalled();
      expect(NodeFS.readFileSync(file, "utf8")).toBe(before);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("redacts credentials and uses recorded origins", () =>
    Effect.gen(function* () {
      const root = fixture();
      writeRuntime(root, {
        origin: "http://user:password@127.0.0.1:15432/private?token=secret#secret",
        devUrl: "http://user:password@localhost:6543/pair?token=secret#secret",
        token: "secret",
      });
      const probe = vi.fn((_origin: string) => Effect.succeed("responding"));
      const status = yield* collectDevStatus({
        cwd: root,
        env: { OPENAI_API_KEY: "secret", T3CODE_DESKTOP_REMOTE_DEBUGGING_PORT: "secret" },
        isProcessAlive: () => true,
        probe,
      });
      expect(probe.mock.calls).toEqual([["http://127.0.0.1:15432"], ["http://localhost:6543"]]);
      const output = formatDevStatus(status);
      for (const value of ["password", "secret", "/private", "?token", "OPENAI_API_KEY"]) {
        expect(output).not.toContain(value);
      }
      expect(status.desktop).toContain("running unknown");
      expect(status.mobile).toContain("installed/running unknown");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not log malformed runtime contents", () =>
    Effect.gen(function* () {
      const root = fixture();
      const file = writeRuntime(root);
      NodeFS.writeFileSync(file, '{"token":"never-print-this",');
      const log = vi.fn();
      const status = yield* collectDevStatus({ cwd: root, env: {} }).pipe(
        Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make(log)])),
      );
      expect(formatDevStatus(status)).not.toContain("never-print-this");
      expect(log).not.toHaveBeenCalled();
      expect(NodeFS.readFileSync(file, "utf8")).toContain("never-print-this");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("dev status HTTP checks and client configuration", () => {
  it.effect("never fetches non-loopback or non-HTTP URLs", () =>
    Effect.gen(function* () {
      const fetch = vi.fn();
      const probe = (origin: string) =>
        probeStatusOrigin(origin).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
      expect(yield* probe("https://example.com:443/pair?token=secret")).toContain("not checked");
      expect(yield* probe("file:///tmp/secret")).toContain("invalid");
      expect(statusOrigin("not-a-url-secret")).toBeUndefined();
      expect(fetch).not.toHaveBeenCalled();
    }),
  );

  it.effect("uses credential-free HEAD requests without redirects", () =>
    Effect.gen(function* () {
      const fetch = vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://example.com" },
          }),
      );
      const result = yield* probeStatusOrigin(
        "http://user:secret@localhost:6543/pair?token=secret",
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
      expect(result).toContain("readiness unverified");
      expect(fetch).toHaveBeenCalledWith(
        new URL("http://127.0.0.1:6543"),
        expect.objectContaining({
          method: "HEAD",
          redirect: "manual",
          credentials: "omit",
        }),
      );
    }),
  );

  it.effect("reports failed checks without exposing errors", () =>
    Effect.gen(function* () {
      const fetch = vi.fn(async () => {
        throw new Error("secret");
      });
      const result = yield* probeStatusOrigin("http://127.0.0.1:6543").pipe(
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      );
      expect(result).toBe("unavailable (loopback HTTP check failed)");
    }),
  );

  it.effect("checks IPv6 when localhost is not listening on IPv4", () =>
    Effect.gen(function* () {
      const fetch = vi
        .fn()
        .mockRejectedValueOnce(new Error("IPv4 unavailable"))
        .mockResolvedValueOnce(new Response(null, { status: 200 }));
      const result = yield* probeStatusOrigin("http://localhost:6543").pipe(
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      );
      expect(result).toContain("HTTP 200");
      expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
        "http://127.0.0.1:6543/",
        "http://[::1]:6543/",
      ]);
    }),
  );

  it("reports debug configuration and points to the mobile identity source", () => {
    const status = describeStatusClients({
      T3CODE_DESKTOP_REMOTE_DEBUGGING_PORT: "9222",
      APP_VARIANT: "development",
      T3CODE_IOS_PERSONAL_TEAM: "1",
      T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID: "dev.example.personal",
    });
    expect(status.desktop).toBe("debug port 9222 configured; running unknown");
    expect(status.mobile).toContain("app-identity.mjs");
    expect(status.mobile).toContain("installed/running unknown");
    expect(status.mobile).not.toContain("dev.example.personal");
  });
});
