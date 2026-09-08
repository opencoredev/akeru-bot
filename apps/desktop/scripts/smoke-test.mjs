import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const desktopDir = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const fatalPattern =
  /Cannot find module|MODULE_NOT_FOUND|Refused to execute|Uncaught\b|fatal startup error|render-process-gone|main window render process gone|main window failed to load|renderer process crashed|Failed to load URL/i;
const readinessMarkers = ["backend ready", "main window created"];

export function resolveSmokeElectronPath() {
  const require = NodeModule.createRequire(import.meta.url);
  const packageDir = NodePath.dirname(require.resolve("electron/package.json"));
  // Read the installed runtime directly; the branded launcher registers OS URL schemes.
  const relativePath = NodeFS.readFileSync(NodePath.join(packageDir, "path.txt"), "utf8").trim();
  const distDir = NodePath.join(packageDir, "dist");
  const executable = NodePath.resolve(distDir, relativePath);
  if (!relativePath || !executable.startsWith(`${distDir}${NodePath.sep}`)) {
    throw new Error("Invalid installed Electron executable path.");
  }
  NodeFS.accessSync(executable, NodeFS.constants.X_OK);
  return executable;
}

export function createSmokeEnvironment(root, inherited = process.env) {
  const env = Object.fromEntries(
    Object.entries(inherited).filter(
      ([key]) =>
        !/^(T3CODE_|AKERU_|VITE_|ELECTRON_|NODE_OPTIONS$|NODE_PATH$|APPIMAGE$|APPDIR$|HOME$|USERPROFILE$|HOMEDRIVE$|HOMEPATH$|APPDATA$|LOCALAPPDATA$|XDG_(CONFIG|DATA|CACHE|STATE)_HOME$|TMPDIR$|TMP$|TEMP$)/i.test(
          key,
        ),
    ),
  );
  const home = NodePath.join(root, "home");
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: NodePath.join(root, "tmp"),
    TMP: NodePath.join(root, "tmp"),
    TEMP: NodePath.join(root, "tmp"),
    HOMEDRIVE: NodePath.parse(home).root.replace(/[\\/]$/, ""),
    HOMEPATH: home.slice(NodePath.parse(home).root.length - 1),
    APPDATA: NodePath.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: NodePath.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: NodePath.join(home, ".config"),
    XDG_DATA_HOME: NodePath.join(home, ".local", "share"),
    XDG_CACHE_HOME: NodePath.join(home, ".cache"),
    XDG_STATE_HOME: NodePath.join(home, ".local", "state"),
    T3CODE_HOME: NodePath.join(root, "akeru"),
    AKERU_HOME: NodePath.join(root, "akeru"),
    T3CODE_DISABLE_AUTO_UPDATE: "true",
    ELECTRON_ENABLE_LOGGING: "1",
  };
}

export async function runSmokeTest({ timeoutMs = 30_000, shutdownMs = 1_500 } = {}) {
  const electronPath = resolveSmokeElectronPath();
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-desktop-smoke-"));
  let child;
  let pid;
  let closed = false;
  let exited = false;
  let output = "";
  let timer;
  let closePromise;
  const signals = new Map();
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone smoke script has no Effect runtime.
  const grouped = NodeOS.platform() !== "win32";
  const signalChild = (signal) => {
    if (!pid) return;
    try {
      if (grouped) process.kill(-pid, signal);
      else {
        // Kill the captured tree so a spawned backend cannot outlive cleanup.
        NodeChildProcess.spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"]);
        if (!closed) child.kill(signal);
      }
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      pid = undefined;
    }
  };
  const cleanup = async () => {
    if (pid) {
      const waitForClose = async () => {
        let deadline;
        try {
          await Promise.race([
            closePromise,
            new Promise((resolve) => {
              deadline = setTimeout(resolve, shutdownMs);
            }),
          ]);
        } finally {
          clearTimeout(deadline);
        }
      };
      signalChild("SIGTERM");
      await waitForClose();
      // A stopped parent can leave backend or renderer children in its group.
      signalChild("SIGKILL");
      if (!closed) await waitForClose();
      if (!closed) throw new Error(`Desktop did not close; retained smoke directory at ${root}.`);
    }
    NodeFS.rmSync(root, { recursive: true, force: true });
  };
  try {
    const env = createSmokeEnvironment(root);
    for (const directory of [
      env.HOME,
      env.TMPDIR,
      env.APPDATA,
      env.LOCALAPPDATA,
      env.XDG_CONFIG_HOME,
      env.XDG_DATA_HOME,
      env.XDG_CACHE_HOME,
      env.XDG_STATE_HOME,
      env.T3CODE_HOME,
    ]) {
      NodeFS.mkdirSync(directory, { recursive: true });
    }
    child = NodeChildProcess.spawn(
      electronPath,
      [
        "--no-default-browser-check",
        "--no-default-protocol-client",
        `--user-data-dir=${NodePath.join(root, "chromium")}`,
        NodePath.join(desktopDir, "dist-electron/main.cjs"),
      ],
      { cwd: desktopDir, detached: grouped, stdio: ["ignore", "pipe", "pipe"], env },
    );
    pid = child.pid;
    closePromise = new Promise((resolve) =>
      child.once("close", () => {
        closed = true;
        resolve();
      }),
    );
    await new Promise((resolve, reject) => {
      const capture = (chunk) => {
        output = (output + chunk.toString()).slice(-1_000_000);
        if (fatalPattern.test(output)) reject(new Error("Fatal desktop startup error."));
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        exited = true;
        reject(
          new Error(
            `Desktop exited before the observation period ended (code ${code}, signal ${signal}).`,
          ),
        );
      });
      child.once("close", () =>
        reject(new Error("Desktop closed before startup verification completed.")),
      );
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
        const listener = () => reject(new Error(`Desktop smoke test interrupted by ${signal}.`));
        signals.set(signal, listener);
        process.once(signal, listener);
      }
      timer = setTimeout(() => {
        const missing = readinessMarkers.filter((marker) => !output.includes(marker));
        if (exited || closed || missing.length > 0) {
          reject(
            new Error(
              `Desktop startup readiness timed out. Missing: ${missing.join(", ") || "live process"}.`,
            ),
          );
        } else {
          resolve();
        }
      }, timeoutMs);
    });
    return "Desktop startup smoke test passed: backend ready and main window created. Renderer content and interaction were not verified.";
  } catch (error) {
    throw new Error(`${error.message}${output ? `\nDesktop output:\n${output}` : ""}`, {
      cause: error,
    });
  } finally {
    clearTimeout(timer);
    // Keep signal handlers installed until the owned process group has stopped.
    try {
      await cleanup();
    } finally {
      for (const [signal, listener] of signals) process.removeListener(signal, listener);
    }
  }
}

if (
  process.argv[1] &&
  NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href === import.meta.url
) {
  runSmokeTest().then(
    (message) => console.log(message),
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}
