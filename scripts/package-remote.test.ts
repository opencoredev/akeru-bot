// @effect-diagnostics nodeBuiltinImport:off - Tests package into isolated temporary directories.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  expectedRemoteAssetNames,
  packageRemoteArchive,
  REMOTE_INSTALLERS,
  REMOTE_TARGETS,
  remoteArchiveName,
  remoteTargetFor,
  writeRemoteManifest,
} from "./package-remote.ts";

const scripts = import.meta.dirname;
const read = (name: string) => NodeFS.readFileSync(NodePath.join(scripts, name), "utf8");
const temporary = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-package-test-"));

describe("package-remote", () => {
  it("publishes exactly the archives the installers download", () => {
    const unix = read("install-remote.sh");
    const windows = read("install-remote.ps1");
    expect(unix).toContain('archive="Akeru-Remote-$version-$platform-$arch.tar.gz"');
    expect(unix).toContain("linux-x64|darwin-arm64) ;;");
    expect(unix).toContain('"$base/AKERU-REMOTE-MANIFEST.txt"');
    expect(unix).toContain('"$base/AKERU-REMOTE-MANIFEST.sig"');
    expect(windows).toContain('$ArchiveName = "Akeru-Remote-$Version-win32-$Architecture.zip"');
    expect(REMOTE_TARGETS.map((target) => `${target.platform}-${target.arch}`)).toEqual([
      "linux-x64",
      "darwin-arm64",
      "win32-x64",
    ]);
    expect(expectedRemoteAssetNames("1.2.3")).toEqual([
      "Akeru-Remote-1.2.3-linux-x64.tar.gz",
      "Akeru-Remote-1.2.3-darwin-arm64.tar.gz",
      "Akeru-Remote-1.2.3-win32-x64.zip",
      "AKERU-REMOTE-MANIFEST.txt",
      "AKERU-REMOTE-MANIFEST.sig",
      "install-remote.sh",
      "install-remote.ps1",
    ]);
    expect(() => remoteTargetFor("linux", "arm64")).toThrow(/not published/);
  });

  it("packages a Unix archive whose launcher stays inside the Akeru home", () => {
    const root = temporary();
    const runtime = NodePath.join(root, "runtime");
    const dist = NodePath.join(runtime, "node_modules", "akeru-bot", "dist");
    NodeFS.mkdirSync(dist, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dist, "bin.mjs"), "");
    NodeFS.writeFileSync(NodePath.join(dist, "service-launcher.mjs"), "");
    const fakeNode = NodePath.join(root, "fake-node");
    NodeFS.writeFileSync(fakeNode, '#!/bin/sh\nprintf \'%s|%s\\n\' "$T3CODE_HOME" "$1"\n', {
      mode: 0o755,
    });
    const license = NodePath.join(root, "LICENSE");
    NodeFS.writeFileSync(license, "MIT\n");

    const archive = packageRemoteArchive({
      runtimeDirectory: runtime,
      outputDirectory: NodePath.join(root, "release"),
      version: "1.2.3",
      target: { platform: "linux", arch: "x64" },
      nodeBinary: fakeNode,
      license,
    });
    expect(NodePath.basename(archive)).toBe("Akeru-Remote-1.2.3-linux-x64.tar.gz");

    // Extract the way install-remote.sh does.
    const installed = NodePath.join(root, "installed");
    NodeFS.mkdirSync(installed);
    NodeChildProcess.execFileSync("tar", [
      "-xzf",
      archive,
      "-C",
      installed,
      "--strip-components=1",
    ]);
    for (const file of [
      "akeru",
      "node/bin/node",
      "remote-admin",
      "initialize-remote-identity.sh",
      "install-remote.sh",
      "VERSION",
      "node_modules/akeru-bot/dist/bin.mjs",
      "node_modules/akeru-bot/dist/service-launcher.mjs",
    ]) {
      expect(NodeFS.existsSync(NodePath.join(installed, file)), file).toBe(true);
    }
    expect(NodeFS.readFileSync(NodePath.join(installed, "VERSION"), "utf8")).toBe("1.2.3\n");

    // The installer links the launcher into the user's bin directory.
    const link = NodePath.join(root, "akeru-link");
    NodeFS.symlinkSync(NodePath.join(installed, "akeru"), link);
    const home = NodePath.join(root, "home");
    const env = { PATH: process.env.PATH, HOME: home, T3CODE_HOME: "/legacy/.t3" };
    const serve = NodeChildProcess.execFileSync(link, ["serve"], { env, encoding: "utf8" });
    expect(serve).toBe(
      `${NodePath.join(home, ".akeru")}|${NodePath.join(installed, "node_modules/akeru-bot/dist/bin.mjs")}\n`,
    );
    const custom = NodeChildProcess.execFileSync(link, ["serve"], {
      env: { ...env, AKERU_HOME: "/srv/akeru" },
      encoding: "utf8",
    });
    expect(custom.split("|")[0]).toBe("/srv/akeru");
    const doctor = NodeChildProcess.spawnSync(link, ["remote", "doctor"], {
      env,
      encoding: "utf8",
    });
    expect(doctor.stdout).toContain(`${NodePath.join(home, ".akeru")}|`);
  });

  it("signs a manifest the installer's openssl check accepts", () => {
    const directory = temporary();
    for (const target of REMOTE_TARGETS) {
      NodeFS.writeFileSync(
        NodePath.join(directory, remoteArchiveName("1.2.3", target)),
        target.arch,
      );
    }
    for (const installer of REMOTE_INSTALLERS) {
      NodeFS.copyFileSync(NodePath.join(scripts, installer), NodePath.join(directory, installer));
    }
    const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ed25519");
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const tailscale = "a".repeat(64);

    // The release refuses a key that does not match the key pinned in the installer.
    expect(() =>
      writeRemoteManifest({
        directory,
        version: "1.2.3",
        privateKeyPem,
        externalChecksums: { "tailscale_1.88.4_amd64.tgz": tailscale },
      }),
    ).toThrow(/does not match/);

    const manifest = writeRemoteManifest({
      directory,
      version: "1.2.3",
      privateKeyPem,
      publicKeyPem,
      externalChecksums: { "tailscale_1.88.4_amd64.tgz": tailscale },
    });
    const lines = manifest.trimEnd().split("\n");
    expect(lines.map((line) => line.slice(66))).toEqual([
      "Akeru-Remote-1.2.3-linux-x64.tar.gz",
      "Akeru-Remote-1.2.3-darwin-arm64.tar.gz",
      "Akeru-Remote-1.2.3-win32-x64.zip",
      "install-remote.sh",
      "install-remote.ps1",
      "tailscale_1.88.4_amd64.tgz",
    ]);
    expect(lines.at(-1)).toBe(`${tailscale}  tailscale_1.88.4_amd64.tgz`);

    const publicKeyPath = NodePath.join(directory, "manifest.pub");
    NodeFS.writeFileSync(publicKeyPath, publicKeyPem);
    const verified = NodeChildProcess.spawnSync("openssl", [
      "pkeyutl",
      "-verify",
      "-pubin",
      "-inkey",
      publicKeyPath,
      "-rawin",
      "-in",
      NodePath.join(directory, "AKERU-REMOTE-MANIFEST.txt"),
      "-sigfile",
      NodePath.join(directory, "AKERU-REMOTE-MANIFEST.sig"),
    ]);
    expect(verified.status).toBe(0);
  });
});
