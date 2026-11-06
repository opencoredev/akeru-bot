import * as NodeFS from "node:fs";
import { SandboxError } from "@opencoredev/sandbox-sdk";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createRemoteBotWorkspace } from "./botWorkspace.ts";
import { BotWorkspacePool } from "./botWorkspacePool.ts";
import {
  binding,
  echoProvider,
  identityFile,
  input,
  removeIdentityFiles,
  saved,
} from "./test-support/sandboxSdk.ts";
import { workspaceIO } from "./test-support/workspaceIO.ts";

afterEach(removeIdentityFiles);

describe("sandbox-sdk bot workspaces", () => {
  it("creates, runs commands, edits files, reattaches by saved ID and destroys", async () => {
    const provider = echoProvider();
    const file = identityFile();
    const created = await createRemoteBotWorkspace(input(file, binding(provider)));

    await created.wake();
    expect(created.created).toBe(true);
    expect(created.capabilities).toEqual({
      pause: false,
      snapshot: false,
      browser: false,
      reconnect: true,
    });
    expect(saved(file)).toEqual({
      provider: "docker",
      providerId: created.providerId,
      workdir: "/workspace",
    });
    await expect(created.inspect()).resolves.toBe("running");

    const sandbox = created.workspace.sandbox;
    const filesystem = created.workspace.filesystem;

    if (!sandbox?.executeCommand || !filesystem) throw new Error("Remote workspace is incomplete.");
    await expect(sandbox.executeCommand("echo", ["hello world"])).resolves.toMatchObject({
      success: true,
      exitCode: 0,
      stdout: "hello world\n",
    });
    await expect(sandbox.executeCommand("fail", [])).resolves.toMatchObject({
      success: false,
      exitCode: 3,
      stderr: "broken\n",
    });
    await filesystem.writeFile("notes/todo.md", "ship it");
    await expect(created.browserEndpoint?.(9223)).rejects.toThrow("This sandbox has no browser.");

    const reattached = await createRemoteBotWorkspace(input(file, binding(provider)));
    await reattached.wake();

    expect(reattached.providerId).toBe(created.providerId);
    await expect(
      reattached.workspace.filesystem?.readFile("notes/todo.md", { encoding: "utf8" }),
    ).resolves.toBe("ship it");

    await reattached.destroy();
    expect(NodeFS.existsSync(file)).toBe(false);
    await expect(provider.connect(created.providerId ?? "")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("keeps the new sandbox ID when setup fails after the provider created it", async () => {
    const provider = echoProvider();
    const file = identityFile();

    const failing = binding(provider, {
      desktop: () => Promise.reject(new Error("desktop unavailable")),
    });

    await expect(createRemoteBotWorkspace(input(file, failing))).rejects.toThrow(
      "desktop unavailable",
    );
    const { providerId } = saved(file);
    await expect(provider.connect(providerId)).resolves.toMatchObject({ state: "running" });

    const retry = await createRemoteBotWorkspace(input(file, binding(provider)));
    expect(retry.providerId).toBe(providerId);
    await retry.destroy();
    expect(NodeFS.existsSync(file)).toBe(false);
  });

  it("forgets a saved ID only after the provider confirms the sandbox is gone", async () => {
    const backing = echoProvider();
    const file = identityFile();

    // A failure after allocation whose cleanup deleted the sandbox, as sandbox-sdk does
    // when handle setup fails (opencoredev/sandbox-sdk#35).
    const cleaned = binding(backing, {
      desktop: async (id) => {
        expect(saved(file).providerId).toBe(id);
        await backing.destroy(id);
        throw new SandboxError("handle setup failed", { code: "unavailable" });
      },
    });

    await expect(createRemoteBotWorkspace(input(file, cleaned))).rejects.toThrow(
      "handle setup failed",
    );
    expect(NodeFS.existsSync(file)).toBe(false);
  });

  it("destroys the sandbox and names its ID when the ID cannot be recorded", async () => {
    const provider = echoProvider();
    const create = vi.spyOn(provider, "create");
    const destroy = vi.spyOn(provider, "destroy");
    const file = identityFile();

    const io = {
      ...workspaceIO,
      writeIdentity: () => Promise.reject(new Error("disk full")),
    };

    const failure = createRemoteBotWorkspace({ ...input(file, binding(provider)), io });
    await expect(failure).rejects.toThrow(/Could not record docker sandbox '.+'/);
    const id = (await create.mock.results[0]?.value)?.id;
    expect(destroy).toHaveBeenCalledWith(id);
    await expect(provider.connect(id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("keeps the saved ID when destroy fails so cleanup can be retried", async () => {
    const provider = echoProvider();
    // The SDK handle keeps the provider's methods, so the spy is installed before creation.
    const destroy = vi.spyOn(provider, "destroy");
    const file = identityFile();
    const workspace = await createRemoteBotWorkspace(input(file, binding(provider)));
    await workspace.wake();

    destroy.mockRejectedValueOnce(
      new SandboxError("provider unavailable", { code: "unavailable" }),
    );
    await expect(workspace.destroy()).rejects.toThrow("provider unavailable");
    expect(saved(file).providerId).toBe(workspace.providerId);

    const retry = await createRemoteBotWorkspace(input(file, binding(provider)));
    await retry.destroy();
    expect(NodeFS.existsSync(file)).toBe(false);
  });

  it("deletes a reattached sandbox that was never woken in this process", async () => {
    const provider = echoProvider();
    const file = identityFile();
    const created = await createRemoteBotWorkspace(input(file, binding(provider)));
    const reattached = await createRemoteBotWorkspace(input(file, binding(provider)));

    await reattached.destroy();
    expect(NodeFS.existsSync(file)).toBe(false);
    await expect(provider.connect(created.providerId ?? "")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("pauses and resumes only when the SDK reports the pause capability", async () => {
    const backing = echoProvider();
    const paused = new Set<string>();

    const pausable: Provider = {
      ...backing,
      capabilities: new Set([...backing.capabilities, "pause"]),
      connect: async (id) => ({
        ...(await backing.connect(id)),
        state: paused.has(id) ? "paused" : "running",
      }),
      pause: vi.fn(async (id: string) => {
        paused.add(id);
      }),
      resume: vi.fn(async (id: string) => {
        paused.delete(id);
      }),
    };

    const workspace = await createRemoteBotWorkspace(
      input(identityFile(), binding(pausable), "e2b"),
    );

    expect(workspace.capabilities?.pause).toBe(true);
    await workspace.wake();
    await workspace.sleep();
    expect(pausable.pause).toHaveBeenCalledWith(workspace.providerId);
    await expect(workspace.inspect()).resolves.toBe("sleeping");
    await workspace.wake();
    expect(pausable.resume).toHaveBeenCalledWith(workspace.providerId);
    await expect(workspace.inspect()).resolves.toBe("running");
    await workspace.destroy();
  });

  it("keeps Railway rules: idle is a no-op and a failed wake never destroys the VM", async () => {
    const backing = echoProvider();
    let running = true;

    const railway: Provider = {
      ...backing,
      connect: async (id) => ({
        ...(await backing.connect(id)),
        state: running ? "running" : "stopped",
      }),
    };

    const destroy = vi.spyOn(railway, "destroy");
    const file = identityFile();
    const create = vi.fn(() => createRemoteBotWorkspace(input(file, binding(railway), "railway")));
    const pool = new BotWorkspacePool();

    const lease = await pool.acquire("railway:credentials:bot", create);
    await lease.release();
    expect(destroy).not.toHaveBeenCalled();

    running = false;
    await expect(pool.acquire("railway:credentials:bot", create)).rejects.toThrow("is not running");
    expect(destroy).not.toHaveBeenCalled();
    expect(saved(file).provider).toBe("railway");

    running = true;
    const retry = await pool.acquire("railway:credentials:bot", create);
    expect(create).toHaveBeenCalledTimes(2);
    await retry.release({ destroy: true });
    expect(destroy).toHaveBeenCalledOnce();
    expect(NodeFS.existsSync(file)).toBe(false);
  });

  it("requires credentials on private previews and normalizes header names", async () => {
    const backing = echoProvider();
    let headers: Record<string, string> | undefined;

    const previews: Provider = {
      ...backing,
      previewUrl: async () => ({
        url: "https://9223-sandbox.example",
        ...(headers ? { headers } : {}),
      }),
    };

    const workspace = await createRemoteBotWorkspace(
      input(identityFile(), binding(previews, { browser: { kind: "private" } }), "upstash"),
    );

    await expect(workspace.browserEndpoint?.(9223)).rejects.toThrow(
      "no authenticated browser endpoint",
    );
    headers = { Authorization: "Bearer token" };
    await expect(workspace.browserEndpoint?.(9223)).resolves.toEqual({
      url: "https://9223-sandbox.example",
      requestHeaders: { authorization: "Bearer token" },
    });
    await workspace.destroy();
  });

  it("marks a loopback preview so hosted connectors never receive it", async () => {
    const backing = echoProvider();

    const previews: Provider = {
      ...backing,
      previewUrl: async () => ({ url: "http://127.0.0.1:49153" }),
    };

    const workspace = await createRemoteBotWorkspace(
      input(identityFile(), binding(previews, { browser: { kind: "loopback" } })),
    );

    await expect(workspace.browserEndpoint?.(9223)).resolves.toEqual({
      url: "http://127.0.0.1:49153",
      requestHeaders: {},
      loopback: true,
    });
    await workspace.destroy();
  });
});
