import { SANDBOX_PROVIDER_CREDENTIALS } from "@akeru/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { partialSdkFixture } from "../test-support/partialSdkFixture.ts";
import { REMOTE_BOT_SANDBOXES } from "./BotWorkspaceTypes.ts";
import { sandboxBinding } from "./SandboxProviders.ts";

const environmentFor = (sandbox: (typeof REMOTE_BOT_SANDBOXES)[number]) =>
  Object.fromEntries(
    SANDBOX_PROVIDER_CREDENTIALS[sandbox].map((credential) => [credential.name, "test-value"]),
  );

describe("sandbox bindings", () => {
  it.each(REMOTE_BOT_SANDBOXES)("loads the %s provider from saved credentials", async (sandbox) => {
    const binding = await sandboxBinding(sandbox, environmentFor(sandbox));

    expect(binding.provider.name).toBe(sandbox === "docker" ? "local" : sandbox);
  });

  it.each(REMOTE_BOT_SANDBOXES.filter((sandbox) => sandbox !== "docker"))(
    "refuses to build %s without its credentials",
    async (sandbox) => {
      await expect(sandboxBinding(sandbox, {})).rejects.toThrow("credential");
    },
  );

  it("keeps Railway and Tenki away from browser control", async () => {
    for (const sandbox of ["railway", "tenki"] as const) {
      const binding = await sandboxBinding(sandbox, environmentFor(sandbox));

      expect(binding.browser.kind).toBe("none");
      expect(binding.provider.capabilities.has("pause")).toBe(sandbox === "tenki");
    }
  });
});

describe("working directories of sandboxes the old adapters made", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads Daytona's sandbox work dir, not the user's home", async () => {
    const { Daytona } = await import("@daytona/sdk");

    const get = vi.spyOn(Daytona.prototype, "get").mockResolvedValue(
      partialSdkFixture<import("@daytona/sdk").Sandbox>({
        getWorkDir: async () => "/home/daytona/app",
      }),
    );

    const binding = await sandboxBinding("daytona", environmentFor("daytona"));

    await expect(binding.legacyWorkdir?.("daytona-sandbox")).resolves.toBe("/home/daytona/app");
    expect(get).toHaveBeenCalledWith("daytona-sandbox");
  });

  it("asks Ascii Box for its default directory with a bare pwd, as the old adapter ran", async () => {
    const { BoxApi } = await import("@asciidev/box-sdk");

    const command = vi.spyOn(BoxApi.prototype, "command").mockResolvedValue({
      ok: true,
      type: "command.finished",
      success: true,
      exitCode: 0,
      stdout: "/home/box\n",
      stderr: "",
      timedOut: false,
    });

    const binding = await sandboxBinding("ascii", environmentFor("ascii"));

    await expect(binding.legacyWorkdir?.("ascii-box")).resolves.toBe("/home/box\n");
    expect(command).toHaveBeenCalledWith({
      boxId: "ascii-box",
      commandRequest: { command: "pwd", timeoutSeconds: 30 },
    });
  });

  it("leaves E2B on $HOME, where its old adapter ran commands", async () => {
    const binding = await sandboxBinding("e2b", environmentFor("e2b"));

    expect(binding.legacyWorkdir).toBeUndefined();
  });
});

describe("reading sandbox state without waking the sandbox", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks E2B for a sandbox's details, never its connect endpoint", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ sandboxID: "e2b-sandbox", state: "paused" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const binding = await sandboxBinding("e2b", environmentFor("e2b"));

    await expect(binding.peek?.("e2b-sandbox")).resolves.toBe("paused");
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/\/sandboxes\/e2b-sandbox$/);
    expect(init?.method ?? "GET").toBe("GET");
    expect(fetch.mock.calls.some(([target]) => String(target).includes("/connect"))).toBe(false);
  });

  it("lists Upstash boxes for their status instead of running a command", async () => {
    const { Box } = await import("@upstash/box");

    const list = vi
      .spyOn(Box, "list")
      .mockResolvedValue([
        partialSdkFixture<import("@upstash/box").BoxData>({ id: "upstash-box", status: "paused" }),
      ]);

    const get = vi.spyOn(Box, "get");
    const binding = await sandboxBinding("upstash", environmentFor("upstash"));

    await expect(binding.peek?.("upstash-box")).resolves.toBe("paused");
    await expect(binding.peek?.("gone-box")).resolves.toBe("missing");
    expect(list).toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });
});

describe("users of sandboxes the old adapters made", () => {
  it("keeps legacy E2B sandboxes on E2B's default user, not the SDK's root", async () => {
    const binding = await sandboxBinding("e2b", environmentFor("e2b"));

    expect(binding.legacyUser).toBe("user");
  });
});
