import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { createSandbox, SandboxError } from "@opencoredev/sandbox-sdk";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";
import { execa } from "execa";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createRemoteBotWorkspace } from "./botWorkspace.ts";
import {
  binding,
  echoProvider,
  identityFile,
  input,
  legacyIdentity,
  removeIdentityFiles,
  saved,
} from "./test-support/sandboxSdk.ts";

afterEach(removeIdentityFiles);

/** A sandbox an old adapter made: files in the user's home, an identity without `workdir`. */
async function legacySandbox(home = "/home/user") {
  const provider = echoProvider();
  const box = await createSandbox(provider, { env: { HOME: home } });
  await box.files.write(`${home || "/"}/notes.md`, "kept from before");
  const file = identityFile();
  legacyIdentity(file, "e2b", box.id);

  return { provider, box, file };
}

describe("sandboxes created before the sandbox-sdk migration", () => {
  it("keep their original working directory for commands, files and listings", async () => {
    const { provider, box, file } = await legacySandbox();
    const workspace = await createRemoteBotWorkspace(input(file, binding(provider), "e2b"));
    await workspace.wake();

    expect(saved(file)).toEqual({ provider: "e2b", providerId: box.id, workdir: "/home/user" });
    await expect(
      workspace.workspace.filesystem?.readFile("notes.md", { encoding: "utf8" }),
    ).resolves.toBe("kept from before");
    expect(
      (await workspace.workspace.filesystem?.readdir("."))?.map((entry) => entry.name),
    ).toContain("notes.md");
    await expect(workspace.workspace.sandbox?.executeCommand?.("pwd", [])).resolves.toMatchObject({
      stdout: "/home/user\n",
    });

    await workspace.workspace.filesystem?.writeFile("todo.md", "next");
    await expect(box.files.read("/home/user/todo.md")).resolves.toBe("next");
    await workspace.destroy();
  });

  it("use the directory the provider's own SDK reports, and resolve it only once", async () => {
    const { provider, box, file } = await legacySandbox();
    let probes = 0;

    const nativeProbe = binding(provider, {
      legacyWorkdir: async () => {
        probes += 1;

        return "/home/user\n";
      },
    });

    await createRemoteBotWorkspace(input(file, nativeProbe, "e2b"));
    const again = await createRemoteBotWorkspace(input(file, nativeProbe, "e2b"));

    expect(probes).toBe(1);
    expect(saved(file).workdir).toBe("/home/user");
    await again.destroy();
    await expect(provider.connect(box.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("fail closed without changing the saved identity when the directory is unknown", async () => {
    const { provider, box, file } = await legacySandbox("");

    await expect(createRemoteBotWorkspace(input(file, binding(provider), "e2b"))).rejects.toThrow(
      `Remove '${file}' to create a replacement`,
    );
    expect(saved(file)).toEqual({ provider: "e2b", providerId: box.id });
    await expect(provider.connect(box.id)).resolves.toMatchObject({ state: "running" });
  });

  it("start new sandboxes in /workspace", async () => {
    const provider = echoProvider();
    const file = identityFile();
    const workspace = await createRemoteBotWorkspace(input(file, binding(provider), "e2b"));
    await workspace.wake();

    expect(saved(file).workdir).toBe("/workspace");
    await workspace.workspace.filesystem?.writeFile("a.txt", "a");
    await expect(workspace.workspace.sandbox?.executeCommand?.("pwd", [])).resolves.toMatchObject({
      stdout: "/workspace\n",
    });
    await workspace.destroy();
  });
});

/**
 * A legacy sandbox that is not running: an archived Ascii box (`pause`) or a stopped Daytona
 * sandbox (`start`). Guest commands fail until it is woken, as they do on the real services.
 */
async function sleepingLegacySandbox(wakeBy: "pause" | "start", home = "/home/user") {
  const backing = echoProvider();
  const box = await createSandbox(backing, { env: { HOME: home } });
  let running = false;

  backing.register("printf", (context) => {
    if (!running) {
      context.stderr("sandbox is not running\n");

      return 1;
    }

    context.stdout(context.args.slice(1).join(""));

    return 0;
  });

  const startRunning = async () => {
    running = true;
  };

  const resume = vi.fn(startRunning);

  const pause = vi.fn(async () => {
    running = false;
  });

  const provider: Provider = {
    ...backing,
    connect: async (id) => ({
      ...(await backing.connect(id)),
      state: running ? "running" : wakeBy === "pause" ? "paused" : "stopped",
    }),
    ...(wakeBy === "pause"
      ? { capabilities: new Set([...backing.capabilities, "pause"]), pause, resume }
      : {}),
  };

  const start = vi.fn(async () => {
    running = true;
  });

  const file = identityFile();
  legacyIdentity(file, "ascii", box.id);

  return {
    box,
    file,
    resume,
    startRunning,
    pause,
    start,
    sandboxBinding: binding(provider, wakeBy === "start" ? { stoppedWake: start } : {}),
  };
}

describe("sleeping sandboxes created before the sandbox-sdk migration", () => {
  it("are resumed before their working directory is read", async () => {
    const { box, file, resume, pause, sandboxBinding } = await sleepingLegacySandbox("pause");

    const workspace = await createRemoteBotWorkspace(input(file, sandboxBinding, "ascii"));

    expect(resume).toHaveBeenCalledOnce();
    expect(pause).not.toHaveBeenCalled();
    expect(saved(file)).toEqual({ provider: "ascii", providerId: box.id, workdir: "/home/user" });
    await workspace.destroy();
  });

  it("are started before their working directory is read when the provider has no resume", async () => {
    const { box, file, start, sandboxBinding } = await sleepingLegacySandbox("start");

    await createRemoteBotWorkspace(input(file, sandboxBinding, "ascii"));

    expect(start).toHaveBeenCalledWith(box.id);
    expect(saved(file).workdir).toBe("/home/user");
  });

  it("keep their identity and go back to sleep when resume starts them and then fails", async () => {
    const { box, file, resume, startRunning, pause, sandboxBinding } =
      await sleepingLegacySandbox("pause");

    // Legacy Tenki: `resume()` starts the VM, then waiting for it to come up fails.
    resume.mockImplementationOnce(async () => {
      await startRunning();
      throw new Error("resume did not finish");
    });

    await expect(createRemoteBotWorkspace(input(file, sandboxBinding, "ascii"))).rejects.toThrow(
      "missing or unavailable",
    );
    expect(saved(file)).toEqual({ provider: "ascii", providerId: box.id });
    expect(pause).toHaveBeenCalledWith(box.id);
  });

  it("keep their identity and go back to sleep when the directory probe fails after waking", async () => {
    const { box, file, resume, pause, sandboxBinding } = await sleepingLegacySandbox("pause", "");

    await expect(createRemoteBotWorkspace(input(file, sandboxBinding, "ascii"))).rejects.toThrow(
      "missing or unavailable",
    );
    expect(resume).toHaveBeenCalledOnce();
    expect(pause).toHaveBeenCalledWith(box.id);
    expect(saved(file)).toEqual({ provider: "ascii", providerId: box.id });
  });
});

/**
 * An E2B-like sandbox: paused, and its SDK `connect` resumes it as a side effect. With
 * `connectFails`, connect resumes it and then throws, as E2B's does when an envd call fails.
 */
async function connectResumingSandbox(home = "/home/user", connectFails = false) {
  const backing = echoProvider();
  const box = await createSandbox(backing, { env: { HOME: home } });
  const state = { running: false, connects: 0 };

  const pause = vi.fn(async () => {
    state.running = false;
  });

  const provider: Provider = {
    ...backing,
    capabilities: new Set([...backing.capabilities, "pause"]),
    connect: async (id) => {
      state.connects += 1;
      state.running = true;

      if (connectFails)
        throw new SandboxError("envd did not answer after resume", { code: "unavailable" });

      return { ...(await backing.connect(id)), state: "running" };
    },
    pause,
    resume: async () => {
      state.running = true;
    },
  };

  const file = identityFile();
  legacyIdentity(file, "e2b", box.id);

  const sandboxBinding = binding(provider, {
    peek: async () => (state.running ? "running" : "paused"),
  });

  return { box, file, state, pause, sandboxBinding };
}

describe("sandboxes whose SDK connect resumes them", () => {
  it("are paused again when reattach fails after connect woke them", async () => {
    const { box, file, state, pause, sandboxBinding } = await connectResumingSandbox("");

    await expect(createRemoteBotWorkspace(input(file, sandboxBinding, "e2b"))).rejects.toThrow(
      "missing or unavailable",
    );
    expect(pause).toHaveBeenCalledWith(box.id);
    expect(state.running).toBe(false);
    expect(saved(file)).toEqual({ provider: "e2b", providerId: box.id });
  });

  it("are paused again when connect resumes them and then throws", async () => {
    const { box, file, state, pause, sandboxBinding } = await connectResumingSandbox(
      "/home/user",
      true,
    );

    await expect(createRemoteBotWorkspace(input(file, sandboxBinding, "e2b"))).rejects.toThrow(
      "missing or unavailable",
    );
    expect(pause).toHaveBeenCalledWith(box.id);
    expect(state.running).toBe(false);
    expect(saved(file)).toEqual({ provider: "e2b", providerId: box.id });
  });

  it("are inspected without being resumed", async () => {
    const { file, state, sandboxBinding } = await connectResumingSandbox();
    const workspace = await createRemoteBotWorkspace(input(file, sandboxBinding, "e2b"));
    const connects = state.connects;

    state.running = false;
    await expect(workspace.inspect()).resolves.toBe("sleeping");
    expect(state.running).toBe(false);
    expect(state.connects).toBe(connects);
  });
});

describe("E2B sandboxes created before the sandbox-sdk migration", () => {
  it("keep running as the sandbox's own user, in that user's home", async () => {
    const backing = echoProvider();
    const box = await createSandbox(backing, { env: { HOME: "/root" } });
    const su: { args: readonly string[]; cwd: string }[] = [];

    // The passwd lookup Akeru runs as the SDK's root user.
    backing.register("sh", (context) => {
      if (context.args[3] !== "user" || !context.args[1]?.includes("/etc/passwd")) return 127;
      context.stdout("/home/user\n");

      return 0;
    });

    backing.register("su", (context) => {
      su.push({ args: context.args, cwd: context.cwd });
      context.stdout("ran as user\n");

      return 0;
    });

    const file = identityFile();
    legacyIdentity(file, "e2b", box.id);

    const workspace = await createRemoteBotWorkspace(
      input(file, binding(backing, { legacyUser: "user" }), "e2b"),
    );

    expect(saved(file)).toEqual({
      provider: "e2b",
      providerId: box.id,
      workdir: "/home/user",
      user: "user",
    });
    await expect(workspace.workspace.sandbox?.executeCommand?.("pwd", [])).resolves.toMatchObject({
      stdout: "ran as user\n",
    });
    expect(su).toEqual([
      {
        args: ["-s", "/bin/sh", "-c", "cd '/home/user' || exit; 'pwd'", "user"],
        cwd: "/home/user",
      },
    ]);

    // With an environment, a failed `cd` must still stop the command. A real shell runs the
    // guest script with its directory pointed at one that cannot exist.
    const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-cd-"));

    try {
      const marker = NodePath.join(scratch, "ran");
      await workspace.workspace.sandbox?.executeCommand?.("touch", [marker], {
        env: { MODE: "x" },
      });
      const script = su.at(-1)?.args[3] ?? "";
      expect(script).toContain("export MODE='x';");

      const missing = NodePath.join(scratch, `missing-${NodeCrypto.randomUUID()}`);

      const ran = await execa("/bin/sh", ["-c", script.replace("'/home/user'", `'${missing}'`)], {
        reject: false,
      });

      expect(ran.exitCode).not.toBe(0);
      expect(NodeFS.existsSync(marker)).toBe(false);
    } finally {
      NodeFS.rmSync(scratch, { recursive: true, force: true });
    }

    // Reattaching again reuses the recorded user without another lookup.
    const again = await createRemoteBotWorkspace(input(file, binding(backing), "e2b"));
    await again.workspace.sandbox?.executeCommand?.("pwd", []);
    expect(su).toHaveLength(3);
  });
});
