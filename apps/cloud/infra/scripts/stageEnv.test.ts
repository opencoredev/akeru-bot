import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadStageEnv, machineEnvPath } from "./stageEnv.ts";

const temps: string[] = [];

const tempDir = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-cloud-env-"));
  temps.push(dir);

  return dir;
};

afterEach(() => {
  for (const dir of temps.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

describe("loadStageEnv", () => {
  it("layers the shell, the machine file, and the checkout's .env", () => {
    const home = tempDir();
    const packageDir = tempDir();
    const machineFile = machineEnvPath("staging", home);
    NodeFS.mkdirSync(NodePath.dirname(machineFile), { recursive: true });
    NodeFS.writeFileSync(
      machineFile,
      "CLERK_SECRET_KEY=sk_machine\nCLERK_PUBLISHABLE_KEY=pk_machine\n",
    );
    NodeFS.writeFileSync(NodePath.join(packageDir, ".env"), "CLERK_PUBLISHABLE_KEY=pk_local\n");

    const { env, loaded } = loadStageEnv({
      stage: "staging",
      home,
      packageDir,
      env: { CLERK_SECRET_KEY: "sk_shell", POSTHOG_KEY: "ph_shell" },
    });

    expect(env).toMatchObject({
      CLERK_SECRET_KEY: "sk_machine",
      CLERK_PUBLISHABLE_KEY: "pk_local",
      POSTHOG_KEY: "ph_shell",
    });
    expect(loaded).toEqual([machineFile, NodePath.join(packageDir, ".env")]);
  });

  it("reads only the requested stage and falls back to the shell", () => {
    const home = tempDir();
    const machineFile = machineEnvPath("production", home);
    NodeFS.mkdirSync(NodePath.dirname(machineFile), { recursive: true });
    NodeFS.writeFileSync(machineFile, "CLERK_SECRET_KEY=sk_production\n");

    const { env, loaded } = loadStageEnv({
      stage: "staging",
      home,
      packageDir: tempDir(),
      env: { CLERK_SECRET_KEY: "sk_shell" },
    });

    expect(env.CLERK_SECRET_KEY).toBe("sk_shell");
    expect(loaded).toEqual([]);
  });
});
