// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { expect, it } from "vite-plus/test";

it("reads AKERU_HOME over an ambient T3CODE_HOME and refuses an incompatible identity before publishing a version or switching the CLI", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-installer-refusal-"));
  const payload = NodePath.join(root, "payload", "Akeru-Remote-1.2.3-linux-x64");
  const releases = NodePath.join(root, "release");
  const tools = NodePath.join(root, "tools");
  const installRoot = NodePath.join(root, "install");
  const binDir = NodePath.join(root, "bin");
  const home = NodePath.join(root, "home");
  const legacy = NodePath.join(root, "legacy-t3");
  NodeFS.mkdirSync(NodePath.join(payload, "node", "bin"), { recursive: true });
  NodeFS.mkdirSync(releases);
  NodeFS.mkdirSync(tools);
  NodeFS.mkdirSync(NodePath.join(installRoot, "versions", "1.0.0"), { recursive: true });
  NodeFS.mkdirSync(binDir);
  NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true });
  NodeFS.mkdirSync(legacy);
  NodeFS.writeFileSync(NodePath.join(payload, "akeru"), "#!/bin/sh\n", { mode: 0o755 });
  NodeFS.symlinkSync(process.execPath, NodePath.join(payload, "node", "bin", "node"));
  NodeFS.copyFileSync(
    new URL("./initialize-remote-identity.sh", import.meta.url),
    NodePath.join(payload, "initialize-remote-identity.sh"),
  );
  NodeFS.chmodSync(NodePath.join(payload, "initialize-remote-identity.sh"), 0o755);
  const archive = NodePath.join(releases, "Akeru-Remote-1.2.3-linux-x64.tar.gz");
  expect(
    NodeChildProcess.spawnSync("tar", [
      "-czf",
      archive,
      "-C",
      NodePath.dirname(payload),
      NodePath.basename(payload),
    ]).status,
  ).toBe(0);
  const hash = NodeChildProcess.spawnSync("sha256sum", [archive], {
    encoding: "utf8",
  }).stdout.split(" ")[0];
  NodeFS.writeFileSync(
    NodePath.join(releases, "AKERU-REMOTE-MANIFEST.txt"),
    `${hash}  ${NodePath.basename(archive)}\n`,
  );
  NodeFS.writeFileSync(NodePath.join(releases, "AKERU-REMOTE-MANIFEST.sig"), "test");
  NodeFS.writeFileSync(
    NodePath.join(tools, "curl"),
    `#!/bin/sh
destination=""
previous=""
for argument in "$@"; do
  [ "$previous" = -o ] && destination="$argument"
  previous="$argument"
done
for argument in "$@"; do source="$argument"; done
cp "$RELEASES/$(basename "$source")" "$destination"
`,
    { mode: 0o755 },
  );
  NodeFS.writeFileSync(NodePath.join(tools, "openssl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  NodeFS.writeFileSync(NodePath.join(installRoot, "versions", "1.0.0", "akeru"), "old\n");
  NodeFS.symlinkSync(
    NodePath.join(installRoot, "versions", "1.0.0", "akeru"),
    NodePath.join(binDir, "akeru"),
  );
  NodeFS.writeFileSync(NodePath.join(home, "userdata", "environment-id"), "existing-env\n");
  const originalTarget = NodeFS.readlinkSync(NodePath.join(binDir, "akeru"));
  const result = NodeChildProcess.spawnSync(
    "sh",
    [NodePath.join(import.meta.dirname, "install-remote.sh")],
    {
      env: {
        ...process.env,
        PATH: `${tools}:${process.env.PATH ?? ""}`,
        RELEASES: releases,
        AKERU_VERSION: "v1.2.3",
        AKERU_INSTALL_ROOT: installRoot,
        AKERU_BIN_DIR: binDir,
        AKERU_HOME: home,
        T3CODE_HOME: legacy,
      },
      encoding: "utf8",
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("--migrate-environment-id");
  expect(NodeFS.readlinkSync(NodePath.join(binDir, "akeru"))).toBe(originalTarget);
  expect(NodeFS.readdirSync(NodePath.join(installRoot, "versions"))).toEqual(["1.0.0"]);
  // The refusal came from AKERU_HOME; the ambient T3 Code home was never touched.
  expect(NodeFS.readdirSync(legacy)).toEqual([]);
  NodeFS.rmSync(root, { recursive: true, force: true });
});
