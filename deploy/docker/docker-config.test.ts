// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { expect, it } from "vite-plus/test";

const read = (path: string) => NodeFS.readFileSync(new URL(path, import.meta.url), "utf8");
const dockerfile = read("./Dockerfile");
const compose = read("./compose.yaml");
const composeDirect = read("./compose.direct.yaml");
const release = read("../../.github/workflows/release.yml");
const entrypoint = read("./akeru-entrypoint.sh");
const dockerignore = read("../../.dockerignore");

it("health-gates the image on the server's environment endpoint", () => {
  expect(dockerfile).toMatch(
    /HEALTHCHECK [^\n]*\\\n\s+CMD curl -fsS http:\/\/127\.0\.0\.1:3773\/\.well-known\/t3\/environment/,
  );
  expect(compose).toContain("${AKERU_IMAGE:-akeru-remote:local}");
  expect(dockerfile).toContain(
    "AKERU_SERVER_ENTRYPOINT=/opt/akeru/node_modules/akeru-bot/dist/bin.mjs",
  );
  expect(dockerfile).toContain("AKERU_REMOTE_CONTAINER=1");
  expect(entrypoint).toContain('exec /opt/akeru/remote-admin "$@"');
});

it("never schedules the unsupported hosted heartbeat command", () => {
  for (const file of [dockerfile, compose, composeDirect, entrypoint]) {
    expect(file).not.toContain("heartbeat");
  }
});

it("does not build or publish a Docker release artifact", () => {
  expect(release).not.toContain("docker build");
  expect(release).not.toContain("docker save");
  expect(release).not.toContain("Akeru-Remote-Docker");
});

it("keeps Akeru's data in AKERU_HOME and ignores an ambient T3CODE_HOME", () => {
  expect(dockerfile).toContain("AKERU_HOME=/data");
  for (const file of [dockerfile, compose, composeDirect]) {
    expect(file).not.toContain("T3CODE_HOME");
  }

  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-entrypoint-"));
  try {
    const entry = NodePath.join(root, "akeru");
    // Replace the container paths with a probe that reports the server's resolved home.
    NodeFS.writeFileSync(
      entry,
      entrypoint
        .replace("/opt/akeru/initialize-remote-identity.sh", "true")
        .replace(
          /exec node \/opt\/akeru\/node_modules\/akeru-bot\/dist\/bin\.mjs "\$@"/,
          'printf "%s|%s" "$AKERU_HOME" "$T3CODE_HOME"',
        ),
      { mode: 0o755 },
    );
    const run = (env: Record<string, string>) =>
      NodeChildProcess.spawnSync("sh", [entry, "serve"], {
        env: { PATH: process.env.PATH ?? "", HOME: root, ...env },
        encoding: "utf8",
      }).stdout;
    expect(run({ T3CODE_HOME: "/legacy/.t3" })).toBe(`${root}/.akeru|${root}/.akeru`);
    expect(run({ T3CODE_HOME: "/legacy/.t3", AKERU_HOME: "/data" })).toBe("/data|/data");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("keeps root and nested environment and private-key files out of the Docker context", () => {
  expect(dockerignore).toContain(".env.*");
  expect(dockerignore).toContain("**/.env.*");
  expect(dockerignore).toContain(".env*");
  expect(dockerignore).toContain("**/.env*");
  expect(dockerignore).toContain("!.env.example");
  expect(dockerignore).toContain("!**/.env.example");
  expect(dockerignore).toContain("**/*.pem");
  expect(dockerignore).toContain("**/*.key");
});
