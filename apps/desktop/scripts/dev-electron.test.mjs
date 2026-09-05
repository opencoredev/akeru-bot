import * as NodeEvents from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  watch: vi.fn(),
  platform: vi.fn(),
  resolveDevProtocolClient: vi.fn(),
  resolveElectronLaunchCommand: vi.fn(),
  waitForResources: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawn: mocks.spawn, spawnSync: mocks.spawnSync }));
vi.mock("node:fs", () => ({ watch: mocks.watch }));
vi.mock("node:os", () => ({ platform: mocks.platform }));
vi.mock("./electron-launcher.mjs", () => ({
  desktopDir: "/repo/apps/desktop",
  resolveDevProtocolClient: mocks.resolveDevProtocolClient,
  resolveElectronLaunchCommand: mocks.resolveElectronLaunchCommand,
}));
vi.mock("./wait-for-resources.mjs", () => ({ waitForResources: mocks.waitForResources }));

const killProcess = process.kill.bind(process);

let apps;
let watchers;
let signals;
let kill;
let exit;

async function launch(platform = "darwin") {
  mocks.platform.mockReturnValue(platform);
  await import("./dev-electron.mjs");
}

async function changeBuild() {
  watchers[0].onChange("change", "main.cjs");
  await vi.advanceTimersByTimeAsync(120);
}

describe("desktop development process ownership", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.stubEnv("VITE_DEV_SERVER_URL", "http://localhost:5173");
    vi.stubEnv("T3CODE_DESKTOP_REMOTE_DEBUGGING_PORT", "");
    apps = [];
    watchers = [];
    signals = new Map();
    kill = vi.spyOn(process, "kill").mockReturnValue(true);
    exit = vi.spyOn(process, "exit").mockImplementation(() => undefined);
    vi.spyOn(process, "once").mockImplementation((signal, listener) => {
      signals.set(signal, listener);
      return process;
    });
    mocks.resolveElectronLaunchCommand.mockImplementation((args) => ({
      electronPath: "/runtime/Electron",
      args,
    }));
    mocks.spawn.mockImplementation(() => {
      const app = new NodeEvents.EventEmitter();
      app.pid = 4100 + apps.length;
      app.kill = vi.fn();
      apps.push(app);
      return app;
    });
    mocks.watch.mockImplementation((_directory, _options, onChange) => {
      const watcher = { onChange, close: vi.fn() };
      watchers.push(watcher);
      return watcher;
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each(["darwin", "linux"])(
    "starts an isolated group on %s without cleaning pre-existing processes",
    async (platform) => {
      await launch(platform);

      expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(
        "/runtime/Electron",
        ["--t3code-dev-root=/repo/apps/desktop", "dist-electron/main.cjs"],
        expect.objectContaining({ detached: true, stdio: "inherit" }),
      );
      expect(kill).not.toHaveBeenCalled();
      expect(mocks.spawnSync).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, { appBundleId: "dev.akeru.test" }])(
    "binds enabled remote debugging to loopback with protocol client %j",
    async (protocolClient) => {
      vi.stubEnv("T3CODE_DESKTOP_REMOTE_DEBUGGING_PORT", " 9222 ");
      mocks.resolveDevProtocolClient.mockReturnValue(protocolClient);
      await launch();

      expect(mocks.resolveElectronLaunchCommand).toHaveBeenCalledExactlyOnceWith(
        expect.arrayContaining([
          "--remote-debugging-address=127.0.0.1",
          "--remote-debugging-port=9222",
        ]),
      );
    },
  );

  it("stops only the captured group and waits for exit before restarting", async () => {
    await launch();
    const app = apps[0];
    app.pid = 9999;
    await changeBuild();

    expect(kill.mock.calls).toEqual([[-4100, "SIGTERM"]]);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    app.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(0);

    expect(kill.mock.calls).toEqual([
      [-4100, "SIGTERM"],
      [-4100, "SIGKILL"],
    ]);
    expect(app.kill).not.toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1500);
    expect(kill).toHaveBeenCalledTimes(2);
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });

  it("forces only the owned group and does not signal it again on a late exit", async () => {
    await launch();
    await changeBuild();
    await vi.advanceTimersByTimeAsync(1500);

    expect(kill.mock.calls).toEqual([
      [-4100, "SIGTERM"],
      [-4100, "SIGKILL"],
    ]);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    apps[0].emit("exit", null, "SIGKILL");
    await vi.advanceTimersByTimeAsync(1500);
    expect(kill).toHaveBeenCalledTimes(2);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });

  it("cleans remaining group members after a crash and restarts", async () => {
    await launch();
    apps[0].emit("exit", 1, null);
    expect(kill.mock.calls).toEqual([[-4100, "SIGKILL"]]);
    await vi.advanceTimersByTimeAsync(120);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });

  it("cleans remaining group members after a normal exit without restarting", async () => {
    await launch();
    apps[0].emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(2000);
    expect(kill.mock.calls).toEqual([[-4100, "SIGKILL"]]);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("retries a failed spawn without signaling an unknown PID", async () => {
    mocks.spawn.mockImplementationOnce(() => {
      const app = new NodeEvents.EventEmitter();
      apps.push(app);
      return app;
    });
    await launch();
    apps[0].emit("error", new Error("spawn failed"));
    await vi.advanceTimersByTimeAsync(120);
    expect(kill).not.toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });

  it("releases a missing group without retrying its PID", async () => {
    await launch();
    kill.mockImplementationOnce(() => {
      throw Object.assign(new Error("missing group"), { code: "ESRCH" });
    });
    await changeBuild();
    apps[0].emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(1500);
    expect(kill.mock.calls).toEqual([[-4100, "SIGTERM"]]);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ])("waits for an active restart cleanup on %s without spawning again", async (signal, code) => {
    await launch();
    await changeBuild();
    signals.get(signal)();
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);

    expect(exit).toHaveBeenCalledExactlyOnceWith(code);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(kill.mock.calls).toEqual([
      [-4100, "SIGTERM"],
      [-4100, "SIGKILL"],
    ]);
    expect(watchers[0].close).toHaveBeenCalledOnce();
    expect(watchers[1].close).toHaveBeenCalledOnce();
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });

  it("cancels a pending restart during shutdown", async () => {
    await launch();
    watchers[0].onChange("change", "main.cjs");
    signals.get("SIGTERM")();
    await vi.advanceTimersByTimeAsync(0);
    apps[0].emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(143);
  });

  // oxlint-disable-next-line t3code/no-global-process-runtime -- Process-group smoke tests require POSIX signals.
  it.skipIf(process.platform === "win32").each([false, true])(
    "cleans a real owned child and grandchild, with forced shutdown %s",
    async (forceShutdown) => {
      const { spawn } = await vi.importActual("node:child_process");
      const grandchildScript = `
        process.on("SIGTERM", () => {});
        process.send("ready");
        setInterval(() => {}, 1000);
      `;
      const childScript = `
        const { spawn } = require("node:child_process");
        process.on("SIGTERM", () => { ${forceShutdown ? "" : "process.exit(0);"} });
        const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}], {
          stdio: ["ignore", "inherit", "inherit", "ipc"],
        });
        grandchild.once("message", () => process.send("ready"));
        setInterval(() => {}, 1000);
      `;
      const unrelated = spawn(
        process.execPath,
        [
          "-e",
          `
        process.on("message", () => process.send("alive"));
        process.send("ready");
      `,
        ],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] },
      );
      const unrelatedExit = NodeEvents.once(unrelated, "exit");
      let app;
      let ready;
      let closed;
      let appClosed = false;
      try {
        await NodeEvents.once(unrelated, "message");
        mocks.spawn.mockImplementationOnce(() => {
          app = spawn(process.execPath, ["-e", childScript], {
            detached: true,
            stdio: ["ignore", "pipe", "pipe", "ipc"],
          });
          ready = NodeEvents.once(app, "message");
          // Inherited pipes close only after both processes release them.
          closed = NodeEvents.once(app, "close").then(() => {
            appClosed = true;
          });
          return app;
        });
        kill.mockImplementation(killProcess);
        await launch();
        await ready;
        signals.get("SIGTERM")();
        await vi.advanceTimersByTimeAsync(0);
        expect(kill).toHaveBeenCalledWith(-app.pid, "SIGTERM");
        if (!forceShutdown) {
          await closed;
        }
        await vi.advanceTimersByTimeAsync(1500);
        await closed;
        await vi.advanceTimersByTimeAsync(0);

        expect(kill.mock.calls).toEqual([
          [-app.pid, "SIGTERM"],
          [-app.pid, "SIGKILL"],
        ]);
        expect(exit).toHaveBeenCalledExactlyOnceWith(143);
        expect(mocks.spawn).toHaveBeenCalledTimes(1);
        const reply = NodeEvents.once(unrelated, "message");
        unrelated.send("ping");
        expect(await reply).toEqual(["alive", undefined]);
      } finally {
        if (app && !appClosed) {
          killProcess(-app.pid, "SIGKILL");
          await closed;
        }
        unrelated.kill("SIGKILL");
        await unrelatedExit;
      }
    },
  );

  it("uses only the spawned child on Windows", async () => {
    await launch("win32");
    expect(mocks.spawn.mock.calls[0][2].detached).toBe(false);
    await changeBuild();
    expect(apps[0].kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(1500);
    expect(apps[0].kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(kill).not.toHaveBeenCalled();
    expect(mocks.spawnSync).not.toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });
});
