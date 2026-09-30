// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { createMcpManager, type McpServerConfig } from "@mastra/code-sdk/mcp/index";
import { McpServerId, type McpServer } from "@akeru/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { isInstallableManifest, loadManifestCatalog } from "../../../../plugins/manifestCatalog.ts";
import { startHttpMcpFixture } from "./pluginLifecycleFixtures.ts";
import { toMcpServerConfigs } from "./Layers/AgentController.ts";
import { withMcpRuntimeHeaders } from "./McpServerConfig.ts";

const STDIO_FIXTURE = new URL("./pluginLifecycleStdioFixture.mjs", import.meta.url).pathname;
const PLUGIN_ENTRIES = new URL("../../../../plugins/entries/", import.meta.url);

function catalogManifests() {
  return Object.fromEntries(
    NodeFS.readdirSync(PLUGIN_ENTRIES, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => [
        `./entries/${entry.name}/plugin.json`,
        JSON.parse(
          NodeFS.readFileSync(new URL(`${entry.name}/plugin.json`, PLUGIN_ENTRIES), "utf8"),
        ),
      ]),
  );
}

function temporaryRuntimeDir() {
  return NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-plugin-matrix-"));
}

/**
 * Runs the lifecycle each directory entry must pass before it can be marked
 * `available`: install as a server config, connect, health check via a real
 * tool call, disconnect, reconnect, and remove. The recipe mirrors the manifest
 * transport, so manifest drift breaks the matrix.
 */
async function runLifecycle(config: McpServerConfig) {
  const registration: McpServer =
    "url" in config
      ? withMcpRuntimeHeaders(
          {
            id: McpServerId.make("matrix-target"),
            name: "matrix-target",
            transport: "url",
            url: config.url,
            enabled: true,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          config.headers ?? {},
        )
      : {
          id: McpServerId.make("matrix-target"),
          name: "matrix-target",
          transport: "stdio",
          command: config.command,
          ...(config.args ? { args: config.args } : {}),
          enabled: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        };
  const registeredConfig = toMcpServerConfigs([registration])["matrix-target"];
  if (!registeredConfig) throw new Error("MCP fixture registration was not projected.");
  const managers: ReturnType<typeof createMcpManager>[] = [];
  const manager = createMcpManager(temporaryRuntimeDir(), ".akeru-matrix-test", {
    "matrix-target": registeredConfig,
  });
  try {
    // install + connect
    await manager.init();
    let status = manager.getServerStatuses().find((entry) => entry.name === "matrix-target");
    expect(status?.connected).toBe(true);
    expect(status?.toolNames).toContain("matrix-target_echo");

    // health: a real tool call, not a socket check
    const echo = manager.getTools()["matrix-target_echo"] as
      | { execute?: (args: unknown, options: unknown) => Promise<unknown> }
      | undefined;
    await expect(echo?.execute?.({ text: "health" }, {})).resolves.toMatchObject({
      content: [{ type: "text", text: "echo:health" }],
    });

    // disconnect + reconnect: `disconnect` tears the whole client down, so a
    // fresh manager models the per-server reconnect the bot tools expose.
    await manager.disconnect();
    const restarted = createMcpManager(temporaryRuntimeDir(), ".akeru-matrix-test", {
      "matrix-target": registeredConfig,
    });
    managers.push(restarted);
    await restarted.init();
    const reconnected = await restarted.reconnectServer("matrix-target");
    expect(reconnected.connected).toBe(true);
    status = reconnected;
    expect(status.toolNames).toContain("matrix-target_echo");

    // Removal is represented by rebuilding the manager without the registration.
    await restarted.disconnect();
    const removed = createMcpManager(temporaryRuntimeDir(), ".akeru-matrix-test");
    managers.push(removed);
    await removed.init();
    expect(removed.getServerStatuses()).toEqual([]);
    expect(removed.getTools()).toEqual({});
  } finally {
    await manager.disconnect();
    while (managers.length > 0) await managers.pop()?.disconnect();
  }
}

describe("plugin lifecycle matrix execution", () => {
  const fixtures: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    while (fixtures.length > 0) await fixtures.pop()?.close();
  });

  it("runs the local stdio lifecycle for the Computer Use recipe shape", async () => {
    const catalog = loadManifestCatalog(catalogManifests());
    for (const pluginId of ["computer-use"]) {
      const plugin = catalog.find((entry) => entry.id === pluginId);
      if (plugin?.transport.type !== "stdio") {
        throw new TypeError(`Plugin '${pluginId}' is missing its stdio recipe.`);
      }
      // `akeru-codex-computer-use` is not on PATH in CI; the fixture substitutes
      // the command while keeping the manifest's `<command> mcp` recipe shape.
      await runLifecycle({
        command: process.execPath,
        args: [STDIO_FIXTURE, ...(plugin.transport.args ?? [])],
      });
    }
  });

  it("runs the URL connect/health/reconnect lifecycle for pending vendor entries against a fake", async () => {
    const fixture = await startHttpMcpFixture();
    fixtures.push(fixture);
    const catalog = loadManifestCatalog(catalogManifests());
    for (const pluginId of ["context", "exa", "firecrawl", "parallel-search", "hoplite"]) {
      const plugin = catalog.find((entry) => entry.id === pluginId);
      if (plugin?.transport.type !== "url") {
        throw new TypeError(`Plugin '${pluginId}' is missing its URL recipe.`);
      }
      expect(plugin.connection.type).toBe("verification-pending");
      expect(plugin.transport.url).toMatch(/^https:\/\//);
      await runLifecycle({ url: fixture.url });
    }
  });

  it("runs Executor 2 discovery with the required bearer header", async () => {
    const fixture = await startHttpMcpFixture({ authorization: "Bearer fixture-token" });
    fixtures.push(fixture);
    const executor = loadManifestCatalog(catalogManifests()).find(
      (entry) => entry.id === "executor",
    );
    if (executor?.transport.type !== "url") {
      throw new TypeError("Executor is missing its HTTP recipe.");
    }
    expect(executor.transport.url).toBe("https://executor.sh/mcp");
    expect(executor.authentication).toBe("oauth");
    await runLifecycle({ url: fixture.url, headers: { authorization: "Bearer fixture-token" } });
  });

  it("keeps every unverified entry non-installable with a named blocker", () => {
    const catalog = loadManifestCatalog(catalogManifests());
    for (const plugin of catalog) {
      if (plugin.catalogStatus === "available" || plugin.catalogStatus === "deprecated") continue;
      expect(isInstallableManifest(plugin)).toBe(false);
      if (plugin.connection.type === "brokered") {
        expect(plugin.connection.pendingBlocker).toBeTruthy();
      } else if (
        plugin.connection.type === "approval-pending" ||
        plugin.connection.type === "verification-pending"
      ) {
        expect(plugin.connection.blocker.length).toBeGreaterThan(20);
      }
    }
    // Gmail is the only brokered entry today: it keeps its Composio connect
    // shape but reports the credential blocker instead of fake availability.
    const gmail = catalog.find((entry) => entry.id === "gmail");
    expect(gmail?.connection).toMatchObject({
      type: "brokered",
      pendingBlocker: expect.stringContaining("Composio"),
    });
  });
});
