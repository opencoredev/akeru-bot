// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { afterEach, describe, expect, it } from "vite-plus/test";

const shell = NodeFS.readFileSync(new URL("./akeru-remote-admin.sh", import.meta.url), "utf8");
const module = NodeFS.readFileSync(new URL("./akeru-remote-admin.mjs", import.meta.url), "utf8");
const roots: string[] = [];
const tempRoot = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-remote-admin-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

describe("Akeru Remote administration", () => {
  it("parses as POSIX shell and has no hosted account commands", () => {
    expect(
      NodeChildProcess.spawnSync("sh", [
        "-n",
        new URL("./akeru-remote-admin.sh", import.meta.url).pathname,
      ]).status,
    ).toBe(0);
    expect(module).not.toContain("app.akeru.bot");
    expect(module).toContain("Hosted account linking is not part");
    expect(shell).not.toMatch(/Usage:[^\n]*heartbeat/);
  });

  it("hands the server the Akeru home from the shell helper, never an ambient T3CODE_HOME", () => {
    const root = tempRoot();
    NodeFS.mkdirSync(NodePath.join(root, "node", "bin"), { recursive: true });
    NodeFS.copyFileSync(
      new URL("./akeru-remote-admin.sh", import.meta.url),
      NodePath.join(root, "remote-admin"),
    );
    // The fake runtime reports the home the server would use.
    NodeFS.writeFileSync(
      NodePath.join(root, "node", "bin", "node"),
      '#!/bin/sh\nprintf "%s" "$T3CODE_HOME"\n',
      {
        mode: 0o755,
      },
    );
    const run = (env: Record<string, string>) =>
      NodeChildProcess.spawnSync("sh", [NodePath.join(root, "remote-admin"), "doctor"], {
        env: { PATH: process.env.PATH ?? "", HOME: root, ...env },
        encoding: "utf8",
      }).stdout;
    expect(run({ T3CODE_HOME: "/legacy/.t3" })).toBe(NodePath.join(root, ".akeru"));
    expect(run({ T3CODE_HOME: "/legacy/.t3", AKERU_HOME: "/srv/akeru" })).toBe("/srv/akeru");
  });

  it("hands the server the Akeru home from the Windows helper, never an ambient T3CODE_HOME", () => {
    const root = tempRoot();
    NodeFS.copyFileSync(
      new URL("./akeru-remote-admin.mjs", import.meta.url),
      NodePath.join(root, "remote-admin.mjs"),
    );
    NodeFS.writeFileSync(NodePath.join(root, "VERSION"), "1.2.3\n");
    const probe = NodePath.join(root, "probe.mjs");
    NodeFS.writeFileSync(probe, "process.stdout.write(process.env.T3CODE_HOME ?? '');\n");
    const run = (env: Record<string, string>) =>
      NodeChildProcess.spawnSync(
        process.execPath,
        [NodePath.join(root, "remote-admin.mjs"), "doctor"],
        {
          env: { PATH: process.env.PATH ?? "", HOME: root, AKERU_SERVER_ENTRYPOINT: probe, ...env },
          encoding: "utf8",
        },
      ).stdout;
    expect(run({ T3CODE_HOME: "/legacy/.t3" })).toBe(NodePath.join(root, ".akeru"));
    expect(run({ T3CODE_HOME: "/legacy/.t3", AKERU_HOME: "/srv/akeru" })).toBe("/srv/akeru");
  });

  it("keeps doctor arguments intact when the Windows launcher forwards `remote`", () => {
    const root = tempRoot();
    NodeFS.copyFileSync(
      new URL("./akeru-remote-admin.mjs", import.meta.url),
      NodePath.join(root, "remote-admin.mjs"),
    );
    NodeFS.writeFileSync(NodePath.join(root, "VERSION"), "1.2.3\n");
    const probe = NodePath.join(root, "probe.mjs");
    NodeFS.writeFileSync(probe, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [
        NodePath.join(root, "remote-admin.mjs"),
        "remote",
        "doctor",
        "--support-bundle",
        "C:\\My Files\\bundle.json",
      ],
      {
        env: { PATH: process.env.PATH ?? "", HOME: root, AKERU_SERVER_ENTRYPOINT: probe },
        encoding: "utf8",
      },
    );
    expect(JSON.parse(result.stdout)).toEqual([
      "__remote-doctor",
      "--support-bundle",
      "C:\\My Files\\bundle.json",
    ]);
  });

  it("removes the Windows service task on uninstall without the CLI boot-service manager", () => {
    const root = tempRoot();
    NodeFS.copyFileSync(
      new URL("./akeru-remote-admin.mjs", import.meta.url),
      NodePath.join(root, "remote-admin.mjs"),
    );
    NodeFS.writeFileSync(NodePath.join(root, "VERSION"), "1.2.3\n");
    const calls = NodePath.join(root, "calls.log");
    const bin = NodePath.join(root, "bin");
    NodeFS.mkdirSync(bin);
    NodeFS.writeFileSync(
      NodePath.join(bin, "schtasks.exe"),
      `#!/bin/sh\necho "schtasks $*" >> "${calls}"\n`,
      { mode: 0o755 },
    );
    const probe = NodePath.join(root, "probe.mjs");
    NodeFS.writeFileSync(
      probe,
      `import * as fs from "node:fs";\nfs.appendFileSync(${JSON.stringify(calls)}, "server\\n");\n`,
    );
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [NodePath.join(root, "remote-admin.mjs"), "remote", "uninstall"],
      {
        env: {
          PATH: `${bin}${NodePath.delimiter}${process.env.PATH ?? ""}`,
          HOME: root,
          AKERU_SERVER_ENTRYPOINT: probe,
        },
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(0);
    expect(NodeFS.readFileSync(calls, "utf8").trim().split("\n")).toEqual([
      "schtasks /End /TN Akeru Remote",
      "schtasks /Delete /F /TN Akeru Remote",
      "schtasks /Delete /F /TN Akeru Remote Update",
      "schtasks /Delete /F /TN Akeru Remote Heartbeat",
    ]);
  });

  it("pins the release manifest key the Windows updater verifies", () => {
    const pinned = NodeFS.readFileSync(
      new URL("./akeru-release-manifest.pub", import.meta.url),
      "utf8",
    );
    expect(module).toContain(pinned.split("\n")[1]);
  });

  describe("Windows remote update", () => {
    const stubRelease = async (
      options: { readonly tamperSignature?: boolean; readonly testRelease?: boolean } = {},
    ) => {
      const root = tempRoot();
      const installRoot = NodePath.join(root, "install");
      const artifact = NodePath.join(installRoot, "versions", "1.0.0");
      const home = NodePath.join(root, "home");
      NodeFS.mkdirSync(artifact, { recursive: true });
      NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true });
      NodeFS.copyFileSync(
        new URL("./akeru-remote-admin.mjs", import.meta.url),
        NodePath.join(artifact, "remote-admin.mjs"),
      );
      NodeFS.writeFileSync(NodePath.join(artifact, "VERSION"), "1.0.0\n");
      NodeFS.writeFileSync(NodePath.join(artifact, "REMOTE_MODE"), "direct\n");
      NodeFS.writeFileSync(
        NodePath.join(home, "userdata", "remote-control-token"),
        "machine-token\n",
      );

      // The release archive holds `akeru\`, like the packaged Windows zip.
      const archiveName = "Akeru-Remote-1.1.0-win32-x64.zip";
      const source = NodePath.join(root, "source");
      NodeFS.mkdirSync(NodePath.join(source, "akeru"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(source, "akeru", "akeru.cmd"), "@echo off\r\n");
      NodeFS.writeFileSync(NodePath.join(source, "akeru", "VERSION"), "1.1.0\n");
      expect(
        NodeChildProcess.spawnSync("python3", ["-m", "zipfile", "-c", archiveName, "akeru"], {
          cwd: source,
        }).status,
      ).toBe(0);
      const archive = NodeFS.readFileSync(NodePath.join(source, archiveName));
      const tar = NodePath.join(root, "tar");
      NodeFS.writeFileSync(tar, '#!/bin/sh\nexec python3 -m zipfile -e "$2" "$4"\n', {
        mode: 0o755,
      });

      const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ed25519");
      const manifestKeyFile = NodePath.join(root, "manifest.pub");
      NodeFS.writeFileSync(manifestKeyFile, publicKey.export({ type: "spki", format: "pem" }));
      const digest = NodeCrypto.createHash("sha256").update(archive).digest("hex");
      const manifest = Buffer.from(`${digest}  ${archiveName}\n`);
      const signature = NodeCrypto.sign(
        null,
        options.tamperSignature ? Buffer.from("forged") : manifest,
        privateKey,
      );
      const updateRequests: unknown[] = [];
      const server = NodeHttp.createServer((request, response) => {
        const origin = `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`;
        const files: Record<string, Buffer> = {
          [`/download/${archiveName}`]: archive,
          "/download/AKERU-REMOTE-MANIFEST.txt": manifest,
          "/download/AKERU-REMOTE-MANIFEST.sig": signature,
        };
        if (request.url === "/repos/opencoredev/akeru-bot/releases/latest") {
          const assets = Object.keys(files).map((file) => ({
            name: file.slice("/download/".length),
            browser_download_url: `${origin}${file}`,
          }));
          response.end(JSON.stringify({ tag_name: "v1.1.0", assets }));
        } else if (request.url === "/api/remote/update" && request.method === "POST") {
          let body = "";
          request.on("data", (chunk) => (body += chunk));
          request.on("end", () => {
            updateRequests.push({
              token: request.headers["x-akeru-machine-token"],
              body: JSON.parse(body),
            });
            response.writeHead(202).end(JSON.stringify({ targetVersion: "1.1.0" }));
          });
        } else if (request.url && files[request.url]) {
          response.end(files[request.url]);
        } else {
          response.writeHead(404).end();
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as NodeNet.AddressInfo).port;
      NodeFS.writeFileSync(
        NodePath.join(home, "userdata", "server-runtime.json"),
        JSON.stringify({ port }),
      );
      try {
        const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
          (resolve) => {
            const child = NodeChildProcess.spawn(
              process.execPath,
              [
                NodePath.join(artifact, "remote-admin.mjs"),
                "update",
                "--api-origin",
                `http://127.0.0.1:${port}`,
                "--manifest-key-file",
                manifestKeyFile,
              ],
              {
                env: {
                  PATH: process.env.PATH ?? "",
                  HOME: root,
                  AKERU_HOME: home,
                  ...(options.testRelease === false ? {} : { AKERU_REMOTE_TEST_RELEASE: "1" }),
                  // The updater must ignore an ambient key override; the shipped launcher never
                  // forwards --manifest-key-file, so production always verifies the pinned key.
                  AKERU_REMOTE_MANIFEST_PUBLIC_KEY: "forged-env-key",
                  AKERU_REMOTE_API_ORIGIN: "https://127.0.0.1:1",
                  AKERU_REMOTE_TAR: tar,
                },
              },
            );
            let stdout = "";
            let stderr = "";
            child.stdout.on("data", (chunk) => (stdout += chunk));
            child.stderr.on("data", (chunk) => (stderr += chunk));
            child.on("close", (code) => resolve({ code, stdout, stderr }));
          },
        );
        return { result, installRoot, updateRequests };
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    };

    it("stages a verified release and asks the service to update", async () => {
      const { result, installRoot, updateRequests } = await stubRelease();
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      const staged = NodePath.join(installRoot, "versions", "1.1.0");
      expect(NodeFS.readFileSync(NodePath.join(staged, "VERSION"), "utf8")).toBe("1.1.0\n");
      expect(NodeFS.readFileSync(NodePath.join(staged, "REMOTE_MODE"), "utf8")).toBe("direct\n");
      expect(updateRequests).toEqual([
        { token: "machine-token", body: { targetVersion: "1.1.0" } },
      ]);
      expect(result.stdout).toContain("entered the transactional launcher");
    });

    it("fails without staging or updating when the manifest signature is bad", async () => {
      const { result, installRoot, updateRequests } = await stubRelease({ tamperSignature: true });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("does not match the pinned Akeru release key");
      expect(NodeFS.existsSync(NodePath.join(installRoot, "versions", "1.1.0"))).toBe(false);
      expect(updateRequests).toEqual([]);
    });

    it("refuses a replacement release key outside release tests", async () => {
      const { result, installRoot, updateRequests } = await stubRelease({ testRelease: false });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("only available to Akeru release tests");
      expect(NodeFS.existsSync(NodePath.join(installRoot, "versions", "1.1.0"))).toBe(false);
      expect(updateRequests).toEqual([]);
    });
  });
});
