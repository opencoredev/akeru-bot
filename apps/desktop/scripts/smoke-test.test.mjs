import * as NodeEvents from "node:events";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 0 })),
  mkdtempSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  readFileSync: vi.fn(),
  accessSync: vi.fn(),
  platform: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn, spawnSync: mocks.spawnSync }));
vi.mock("node:fs", () => ({ ...mocks, constants: { X_OK: 1 } }));
vi.mock("node:os", () => ({ platform: mocks.platform, tmpdir: () => "/tmp" }));
vi.mock("node:module", () => ({ createRequire: () => ({ resolve: mocks.resolve }) }));

import { createSmokeEnvironment, resolveSmokeElectronPath, runSmokeTest } from "./smoke-test.mjs";

const root = "/tmp/akeru-desktop-smoke-owned";
const ready = "[desktop-window] backend ready\n[desktop-window] main window created\n";
let app;
let kill;
let signals;

function launch() {
  // Attach rejection handling before advancing fake time.
  return runSmokeTest({ timeoutMs: 100, shutdownMs: 10 }).then(
    (message) => ({ message }),
    (error) => ({ error }),
  );
}

function close() {
  app.emit("exit", 0, null);
  app.emit("close", 0, null);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  mocks.platform.mockReturnValue("darwin");
  mocks.resolve.mockReturnValue("/installed/electron/package.json");
  mocks.readFileSync.mockReturnValue("Electron.app/Contents/MacOS/Electron\n");
  mocks.mkdtempSync.mockReturnValue(root);
  app = new NodeEvents.EventEmitter();
  app.pid = 4100;
  app.stdout = new NodeEvents.EventEmitter();
  app.stderr = new NodeEvents.EventEmitter();
  app.kill = vi.fn(() => {
    close();
    return true;
  });
  mocks.spawn.mockReturnValue(app);
  kill = vi.spyOn(process, "kill").mockImplementation(() => {
    close();
    return true;
  });
  signals = new Map();
  vi.spyOn(process, "once").mockImplementation((signal, listener) => {
    signals.set(signal, listener);
    return process;
  });
  vi.spyOn(process, "removeListener").mockReturnValue(process);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("desktop smoke isolation", () => {
  it("replaces both homes and every persistent OS profile path and removes inherited launch context", () => {
    const inherited = {
      HOME: "/live",
      USERPROFILE: "/live",
      UserProfile: "/live-case-insensitive",
      TMPDIR: "/live/tmp",
      TEMP: "/live/tmp",
      TMP: "/live/tmp",
      APPDATA: "/live",
      LOCALAPPDATA: "/live",
      XDG_CONFIG_HOME: "/live",
      XDG_DATA_HOME: "/live",
      XDG_CACHE_HOME: "/live",
      T3CODE_HOME: "/live",
      AKERU_HOME: "/live",
      T3CODE_PORT: "3773",
      T3CODE_DESKTOP_LAN_HOST: "0.0.0.0",
      T3CODE_DEV_REMOTE_T3_SERVER_ENTRY_PATH: "/live/server",
      VITE_DEV_SERVER_URL: "http://live",
      VITE_WS_URL: "ws://live",
      ELECTRON_RUN_AS_NODE: "1",
      ELECTRON_OVERRIDE_DIST_PATH: "/branded",
      NODE_OPTIONS: "--require /live/hook",
      NODE_PATH: "/live/modules",
      PATH: "/bin",
    };
    const env = createSmokeEnvironment(root, inherited);
    for (const key of [
      "HOME",
      "USERPROFILE",
      "TMPDIR",
      "TMP",
      "TEMP",
      "APPDATA",
      "LOCALAPPDATA",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
      "XDG_STATE_HOME",
      "T3CODE_HOME",
      "AKERU_HOME",
    ]) {
      expect(env[key].startsWith(`${root}/`)).toBe(true);
    }
    for (const key of [
      "T3CODE_PORT",
      "T3CODE_DESKTOP_LAN_HOST",
      "T3CODE_DEV_REMOTE_T3_SERVER_ENTRY_PATH",
      "VITE_DEV_SERVER_URL",
      "VITE_WS_URL",
      "ELECTRON_RUN_AS_NODE",
      "ELECTRON_OVERRIDE_DIST_PATH",
      "NODE_OPTIONS",
      "NODE_PATH",
    ])
      expect(env).not.toHaveProperty(key);
    expect(env).not.toHaveProperty("UserProfile");
    expect(env.PATH).toBe("/bin");
    expect(inherited.HOME).toBe("/live");
  });

  it("uses only the installed raw runtime, without the launcher or an inherited override", async () => {
    vi.stubEnv("ELECTRON_OVERRIDE_DIST_PATH", "/branded");
    const result = launch();
    expect(mocks.spawn).toHaveBeenCalledWith(
      "/installed/electron/dist/Electron.app/Contents/MacOS/Electron",
      expect.arrayContaining(["--no-default-protocol-client", `--user-data-dir=${root}/chromium`]),
      expect.objectContaining({
        detached: true,
        env: expect.objectContaining({ HOME: `${root}/home` }),
      }),
    );
    close();
    await result;
    expect(mocks.rmSync).toHaveBeenCalledExactlyOnceWith(root, { recursive: true, force: true });
  });

  it.each(["", "../../launcher", "/branded/Electron"])(
    "rejects invalid runtime path %j before creating state",
    (path) => {
      mocks.readFileSync.mockReturnValue(path);
      expect(() => resolveSmokeElectronPath()).toThrow("Invalid installed");
      expect(mocks.mkdtempSync).not.toHaveBeenCalled();
      expect(mocks.spawn).not.toHaveBeenCalled();
    },
  );

  it("does not install a missing runtime", async () => {
    mocks.accessSync.mockImplementation(() => {
      throw new Error("runtime missing");
    });
    expect((await launch()).error.message).toContain("runtime missing");
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.rmSync).not.toHaveBeenCalled();
  });
});

describe("desktop startup evidence and cleanup", () => {
  it.each([0, 1, null])(
    "rejects an early exit with code %j, even with readiness logs",
    async (code) => {
      const result = launch();
      app.stdout.emit("data", ready);
      app.emit("exit", code, code === null ? "SIGSEGV" : null);
      expect((await result).error.message).toContain("exited before");
      expect(kill.mock.calls).toEqual([
        [-4100, "SIGTERM"],
        [-4100, "SIGKILL"],
      ]);
    },
  );

  it.each(["", "app ready", "backend ready", "main window created"])(
    "fails at the deadline without both readiness markers: %j",
    async (output) => {
      const result = launch();
      app.stdout.emit("data", output);
      await vi.advanceTimersByTimeAsync(100);
      expect((await result).error.message).toContain("readiness timed out");
      expect(mocks.rmSync).toHaveBeenCalledOnce();
    },
  );

  it("requires the full observation period and reports startup evidence, not renderer verification", async () => {
    const result = launch();
    app.stdout.emit("data", "backend rea");
    app.stdout.emit("data", "dy\nmain window created");
    await vi.advanceTimersByTimeAsync(99);
    expect(kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await result).message).toContain("Renderer content and interaction were not verified");
    expect(mocks.rmSync).toHaveBeenCalledExactlyOnceWith(root, { recursive: true, force: true });
    expect(process.removeListener).toHaveBeenCalledTimes(3);
  });

  it.each([
    "Cannot find module",
    "MODULE_NOT_FOUND",
    "Refused to execute",
    "Uncaught TypeError",
    "fatal startup error",
    "render-process-gone",
    "main window render process gone",
    "main window failed to load",
    "Failed to load URL",
  ])("fails immediately on %s after readiness", async (failure) => {
    const result = launch();
    app.stdout.emit("data", ready);
    app.stderr.emit("data", failure.slice(0, 4));
    app.stderr.emit("data", failure.slice(4));
    expect((await result).error.message).toContain("Fatal desktop startup error");
  });

  it("cleans the exact directory after a synchronous spawn failure without signaling", async () => {
    mocks.spawn.mockImplementation(() => {
      throw new Error("spawn failed");
    });
    expect((await launch()).error.message).toContain("spawn failed");
    expect(kill).not.toHaveBeenCalled();
    expect(mocks.rmSync).toHaveBeenCalledExactlyOnceWith(root, { recursive: true, force: true });
  });

  it("handles an asynchronous spawn error without a PID", async () => {
    app.pid = undefined;
    const result = launch();
    app.emit("error", new Error("ENOENT"));
    expect((await result).error.message).toContain("ENOENT");
    expect(kill).not.toHaveBeenCalled();
    expect(mocks.rmSync).toHaveBeenCalledOnce();
  });

  it("escalates only the captured group and waits for close before deleting state", async () => {
    kill.mockImplementation((_pid, signal) => {
      if (signal === "SIGKILL") close();
      return true;
    });
    const result = launch();
    app.pid = 9999;
    signals.get("SIGTERM")();
    await vi.advanceTimersByTimeAsync(0);
    expect(kill.mock.calls).toEqual([[-4100, "SIGTERM"]]);
    expect(mocks.rmSync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect((await result).error.message).toContain("interrupted by SIGTERM");
    expect(kill.mock.calls).toEqual([
      [-4100, "SIGTERM"],
      [-4100, "SIGKILL"],
    ]);
    expect(mocks.rmSync).toHaveBeenCalledOnce();
  });

  it("retains state when the owned process does not close", async () => {
    kill.mockReturnValue(true);
    const result = launch();
    signals.get("SIGINT")();
    await vi.advanceTimersByTimeAsync(20);
    expect((await result).error.message).toContain(`retained smoke directory at ${root}`);
    expect(mocks.rmSync).not.toHaveBeenCalled();
  });

  it("does not retry a missing process group", async () => {
    kill.mockImplementation(() => {
      close();
      throw Object.assign(new Error("missing"), { code: "ESRCH" });
    });
    const result = launch();
    close();
    await result;
    expect(kill).toHaveBeenCalledExactlyOnceWith(-4100, "SIGTERM");
    expect(mocks.rmSync).toHaveBeenCalledOnce();
  });

  it("terminates the captured tree on Windows so a backend cannot outlive cleanup", async () => {
    mocks.platform.mockReturnValue("win32");
    const result = launch();
    app.stderr.emit("data", "fatal startup error");
    await result;
    expect(mocks.spawn.mock.calls[0][2].detached).toBe(false);
    expect(app.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(mocks.spawnSync).toHaveBeenCalledWith("taskkill", ["/pid", "4100", "/T", "/F"]);
    expect(kill).not.toHaveBeenCalled();
  });

  it("kills the Windows tree even after the direct child closed", async () => {
    mocks.platform.mockReturnValue("win32");
    const result = launch();
    app.stdout.emit("data", ready);
    close();
    await result;
    // The tree kill still runs against the captured PID after close.
    expect(mocks.spawnSync).toHaveBeenCalledWith("taskkill", ["/pid", "4100", "/T", "/F"]);
    expect(app.kill).not.toHaveBeenCalled();
    expect(mocks.rmSync).toHaveBeenCalledOnce();
  });

  it("cleans state if directory setup fails", async () => {
    mocks.mkdirSync.mockImplementation(() => {
      throw new Error("mkdir failed");
    });
    expect((await launch()).error.message).toContain("mkdir failed");
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.rmSync.mock.calls[0][0]).toBe(NodePath.resolve(root));
  });
});
