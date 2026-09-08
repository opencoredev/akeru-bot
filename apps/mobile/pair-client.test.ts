// @effect-diagnostics nodeBuiltinImport:off - These tests invoke host helpers with device and pairing commands stubbed.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, expect, it } from "vite-plus/test";

// The helper harness spawns bash with shebang stubs; skip those cases on Windows.
// oxlint-disable-next-line t3code/no-global-process-runtime -- Host-platform test guard, not Effect code.
const posixIt = it.skipIf(process.platform === "win32");

const root = NodeURL.fileURLToPath(new URL("../../", import.meta.url));
const scripts = NodePath.join(root, ".agents/skills/test-t3-mobile/scripts");
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    NodeFS.rmSync(directory, { recursive: true, force: true });
});

it("reads development identity from app config and respects the personal-team bundle", () => {
  const identity = (field: string, env = {}) =>
    NodeChildProcess.execFileSync(
      process.execPath,
      [NodePath.join(scripts, "app-identity.mjs"), field],
      {
        encoding: "utf8",
        env: { ...process.env, APP_VARIANT: "production", T3CODE_IOS_PERSONAL_TEAM: "0", ...env },
      },
    ).trim();
  expect(identity("scheme")).toBe("akeru-dev");
  expect(identity("android-package")).toBe("dev.leodoes.akeru.dev");
  expect(identity("ios-bundle-id")).toBe("dev.leodoes.akeru.dev");
  expect(
    identity("ios-bundle-id", {
      T3CODE_IOS_PERSONAL_TEAM: "1",
      T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID: "dev.example.personal",
    }),
  ).toBe("dev.example.personal");
});

function harness() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-pair-helper-"));
  directories.push(directory);
  const log = NodePath.join(directory, "calls.jsonl");
  const stub = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
if (command === 'node' && args[0] !== 'apps/server/src/bin.ts') {
  const result = require('node:child_process').spawnSync(${JSON.stringify(process.execPath)}, args, { stdio: 'inherit', env: process.env });
  process.exit(result.status ?? 1);
}
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({ command, args }) + '\\n');
if (command === 'node') console.log('Pair URL: http://fixture.invalid/pair?token=fake&value=two');
`;
  for (const name of ["node", "adb", "xcrun"])
    NodeFS.writeFileSync(NodePath.join(directory, name), stub, { mode: 0o755 });
  return {
    invoke: (args: string[]) =>
      NodeChildProcess.spawnSync("bash", [NodePath.join(scripts, "pair-client.sh"), ...args], {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          T3CODE_IOS_PERSONAL_TEAM: "0",
          PATH: `${directory}:${process.env.PATH}`,
          CALL_LOG: log,
        },
      }),
    calls: () =>
      NodeFS.readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { command: string; args: string[] }),
  };
}

posixIt.each(["ios", "android"])(
  "invokes %s with encoded pairing arguments and no real device",
  (platform) => {
    const helper = harness();
    const result = helper.invoke([platform, "test-device", "3777", "/isolated path"]);
    expect(result.status, result.stderr).toBe(0);
    const [pair, open] = helper.calls();
    expect(pair?.args).toContain("/isolated path");
    expect(pair?.args).toContain(
      platform === "ios" ? "http://127.0.0.1:3777" : "http://10.0.2.2:3777",
    );
    expect(open?.command).toBe(platform === "ios" ? "xcrun" : "adb");
    const command = open!.args.join(" ");
    expect(command).toContain("akeru-dev://connections/new?pairingUrl=");
    expect(command).toContain("%26value%3Dtwo&autoConnect=1");
    if (platform === "android") expect(command).toContain("' dev.leodoes.akeru.dev");
  },
);

posixIt("keeps the scheme override and rejects invalid arguments before pairing", () => {
  const helper = harness();
  expect(helper.invoke(["ios", "device", "3777", "/isolated", "custom-dev"]).status).toBe(0);
  expect(helper.calls()[1]?.args.join(" ")).toContain("custom-dev://");
  for (const args of [
    [],
    ["other", "device", "3777", "/isolated"],
    ["ios", "device", "65536", "/isolated"],
    ["android", "device", "3777", "/isolated", "bad' scheme"],
  ]) {
    expect(helper.invoke(args).status).toBe(2);
  }
  expect(helper.calls()).toHaveLength(2);
});
