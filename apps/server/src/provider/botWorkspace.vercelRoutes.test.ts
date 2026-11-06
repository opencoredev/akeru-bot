import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createRemoteBotWorkspace } from "./botWorkspace.ts";
import { partialSdkFixture } from "./test-support/partialSdkFixture.ts";
import { identityFile, legacyIdentity, removeIdentityFiles } from "./test-support/sandboxSdk.ts";
import { workspaceIO } from "./test-support/workspaceIO.ts";

afterEach(() => {
  removeIdentityFiles();
  vi.restoreAllMocks();
});

/**
 * A persistent Vercel sandbox the old adapter created: no SDK tags, port 3000 routed. Vercel
 * holds the port list; every `Sandbox.get` returns a snapshot of it, and `update` replaces it
 * with the ports given, as the real API does. The first snapshot is the SDK's handle.
 */
async function legacyVercelSandbox() {
  const { Sandbox } = await import("@vercel/sandbox");
  const vercel = { ports: [3000] };

  const snapshot = () => {
    let routes = vercel.ports.map((port) => ({ port, subdomain: `sbx-${port}` }));

    const sandbox = partialSdkFixture<import("@vercel/sandbox").Sandbox>({
      name: "akeru-vercel",
      tags: {},
      status: "running",
      persistent: true,
      createdAt: new Date(0),
      domain: (port: number) => `https://sbx-${port}.vercel.example`,
    });

    // `routes` is a getter, `update` and `runCommand` overloaded: attached after typing.
    Object.defineProperty(sandbox, "routes", { get: () => routes });
    Object.assign(sandbox, {
      update: vi.fn(async (params: { readonly ports?: readonly number[] }) => {
        // Yield before applying, so concurrent callers interleave as network round trips do.
        for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
        vercel.ports = [...(params.ports ?? [])];
        routes = vercel.ports.map((port) => ({ port, subdomain: `sbx-${port}` }));
      }),
      runCommand: vi.fn(async () => ({ stdout: async () => "/vercel/sandbox\n" })),
    });

    return sandbox;
  };

  const get = vi.spyOn(Sandbox, "get").mockImplementation(async () => snapshot());

  return { vercel, get };
}

async function reattach() {
  const file = identityFile();
  legacyIdentity(file, "vercel", "akeru-vercel");

  return createRemoteBotWorkspace({
    io: workspaceIO,
    threadId: "thread-vercel",
    sandbox: "vercel",
    workspaceId: "akeru-vercel",
    identityFile: file,
    environment: { VERCEL_TOKEN: "token", VERCEL_TEAM_ID: "team", VERCEL_PROJECT_ID: "project" },
  });
}

describe("Vercel browser routes", () => {
  it("routes the browser port on a sandbox created without it, keeping its other routes", async () => {
    const { vercel } = await legacyVercelSandbox();
    const workspace = await reattach();

    expect(workspace.created).toBe(false);
    await expect(workspace.browserEndpoint?.(9223)).resolves.toEqual({
      url: "https://sbx-9223.vercel.example",
      requestHeaders: {},
    });
    expect(vercel.ports).toEqual([3000, 9223]);

    await workspace.browserEndpoint?.(9223);
    expect(vercel.ports).toEqual([3000, 9223]);
  });

  it("keeps a port another client routed after this handle was read", async () => {
    const { vercel } = await legacyVercelSandbox();
    const workspace = await reattach();

    vercel.ports = [3000, 4000];
    await workspace.browserEndpoint?.(9223);
    expect(vercel.ports).toEqual([3000, 4000, 9223]);
  });

  it("keeps both ports when two are routed at once", async () => {
    const { vercel } = await legacyVercelSandbox();
    const workspace = await reattach();

    await Promise.all([workspace.browserEndpoint?.(9223), workspace.browserEndpoint?.(8080)]);
    expect(vercel.ports.toSorted()).toEqual([3000, 8080, 9223]);
  });
});
