import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { chromium } from "playwright-core";

const STARTUP_TIMEOUT_MS = 30_000;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function reservePort() {
  const server = NodeNet.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!address || typeof address === "string")
    throw new Error("Could not reserve a loopback port.");
  return address.port;
}

function runChecked(command, args) {
  const result = NodeChildProcess.spawnSync(command, args, { encoding: "utf8" });
  if (result.status === 0) return;
  throw new Error([result.stdout, result.stderr].filter(Boolean).join("\n").trim());
}

async function waitForRenderer(cdpPort, child) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let browser;
  let lastError;

  while (Date.now() < deadline && !browser) {
    if (child.exitCode !== null) throw new Error(`The app exited with code ${child.exitCode}.`);
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  if (!browser) throw lastError ?? new Error("The Electron debug endpoint did not start.");

  let page;
  while (Date.now() < deadline && !page) {
    page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith("akeru://app/"));
    if (!page) await delay(100);
  }
  if (!page) throw new Error("The packaged app did not create its akeru://app/ renderer.");

  const rendererErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") rendererErrors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => rendererErrors.push(`page: ${error.message}`));
  page.on("requestfailed", (request) => {
    rendererErrors.push(`request: ${request.url()} ${request.failure()?.errorText ?? "failed"}`);
  });

  await page.reload({ waitUntil: "domcontentloaded" });
  try {
    await page.locator("[data-app-sidebar]").waitFor({
      state: "visible",
      timeout: Math.max(1, deadline - Date.now()),
    });
  } catch (error) {
    if (rendererErrors.length > 0) {
      throw new Error(`Renderer errors:\n${rendererErrors.join("\n")}`, { cause: error });
    }
    throw error;
  }
  if (rendererErrors.length > 0) {
    throw new Error(`Renderer errors:\n${rendererErrors.join("\n")}`);
  }
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  const descendants = listDescendantPids(child.pid);
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    delay(5_000).then(() => false),
  ]);
  if (!exited && child.exitCode === null) {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  for (const pid of descendants.toReversed()) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
}

function listDescendantPids(rootPid) {
  const result = NodeChildProcess.spawnSync("ps", ["-axo", "pid=,ppid="], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr.trim());

  const childrenByParent = new Map();
  for (const line of result.stdout.trim().split("\n")) {
    const [pid, parentPid] = line.trim().split(/\s+/).map(Number);
    const children = childrenByParent.get(parentPid) ?? [];
    children.push(pid);
    childrenByParent.set(parentPid, children);
  }

  const descendants = [];
  const pending = [...(childrenByParent.get(rootPid) ?? [])];
  while (pending.length > 0) {
    const pid = pending.pop();
    descendants.push(pid);
    pending.push(...(childrenByParent.get(pid) ?? []));
  }
  return descendants;
}

async function readFailureLogs(stateRoot) {
  const logDir = NodePath.join(stateRoot, "userdata", "logs");
  const sections = [];
  for (const name of ["server-child.log", "desktop.trace.ndjson"]) {
    try {
      const contents = await NodeFSP.readFile(NodePath.join(logDir, name), "utf8");
      sections.push(`--- ${name} ---\n${contents.slice(-12_000)}`);
    } catch {}
  }
  return sections.join("\n");
}

async function main() {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone release smoke script.
  if (process.platform !== "darwin")
    throw new Error("The packaged macOS smoke test requires macOS.");
  const dmgArgument = process.argv.slice(2).find((argument) => argument !== "--");
  const repositoryRoot = NodePath.resolve(import.meta.dirname, "../../..");
  const dmgPath = dmgArgument ? NodePath.resolve(repositoryRoot, dmgArgument) : undefined;
  if (!dmgPath) throw new Error("Usage: node smoke-packaged-macos.mjs <path-to-dmg>");

  const tempDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "akeru-packaged-smoke-"));
  const mountPoint = NodePath.join(tempDir, "mount");
  const stateRoot = NodePath.join(tempDir, "state");
  const chromiumDir = NodePath.join(tempDir, "chromium");
  await Promise.all([
    NodeFSP.mkdir(mountPoint),
    NodeFSP.mkdir(stateRoot),
    NodeFSP.mkdir(chromiumDir),
  ]);

  let mounted = false;
  let child;
  try {
    runChecked("hdiutil", ["attach", dmgPath, "-nobrowse", "-readonly", "-mountpoint", mountPoint]);
    mounted = true;
    const apps = (await NodeFSP.readdir(mountPoint)).filter((name) => name.endsWith(".app"));
    if (apps.length !== 1) throw new Error(`Expected one app in the DMG, found ${apps.length}.`);

    const appName = NodePath.basename(apps[0], ".app");
    const executable = NodePath.join(mountPoint, apps[0], "Contents", "MacOS", appName);
    const [backendPort, cdpPort] = await Promise.all([reservePort(), reservePort()]);
    const env = {
      ...process.env,
      T3CODE_HOME: stateRoot,
      T3CODE_PORT: String(backendPort),
      ELECTRON_ENABLE_LOGGING: "1",
    };
    delete env.ELECTRON_RUN_AS_NODE;

    child = NodeChildProcess.spawn(
      executable,
      [
        `--remote-debugging-port=${cdpPort}`,
        "--remote-debugging-address=127.0.0.1",
        "--headless=new",
        `--user-data-dir=${chromiumDir}`,
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );

    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk.toString()));
    child.stderr.on("data", (chunk) => (output += chunk.toString()));

    try {
      await waitForRenderer(cdpPort, child);
    } catch (error) {
      const logs = await readFailureLogs(stateRoot);
      throw new Error([String(error), output.slice(-12_000), logs].filter(Boolean).join("\n"), {
        cause: error,
      });
    }
    console.log("Packaged macOS smoke test passed.");
  } finally {
    if (child) await stopChild(child);
    if (mounted) runChecked("hdiutil", ["detach", mountPoint, "-force"]);
    await NodeFSP.rm(tempDir, { recursive: true, force: true });
  }
}

await main();
