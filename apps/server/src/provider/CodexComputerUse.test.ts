// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  resolveCodexComputerUseServer,
  sanitizeCodexComputerUseResult,
} from "./CodexComputerUse.ts";

const directories = new Set<string>();

function plugin(command = "./bin/launcher") {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-computer-use-"));
  directories.add(root);
  NodeFS.mkdirSync(NodePath.join(root, "bin"));
  NodeFS.writeFileSync(NodePath.join(root, "bin", "launcher"), "#!/bin/sh\n", { mode: 0o700 });
  NodeFS.writeFileSync(
    NodePath.join(root, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        "computer-use": {
          command,
          args: ["mcp"],
          cwd: ".",
          env_vars: ["CODEX_HOME"],
        },
      },
    }),
  );
  return root;
}

function listing(root: string, overrides?: Record<string, unknown>) {
  return JSON.stringify({
    installed: [
      {
        pluginId: "computer-use@openai-bundled",
        installed: true,
        enabled: true,
        source: { source: "local", path: root },
        ...overrides,
      },
    ],
    available: [],
  });
}

describe("Codex Computer Use resolver", () => {
  afterEach(() => {
    for (const directory of directories) {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
    directories.clear();
  });

  it("resolves the enabled official launcher without persisting its path", async () => {
    const root = plugin();
    const result = await resolveCodexComputerUseServer({
      platform: "darwin",
      run: async () => listing(root),
    });

    expect(result).toEqual({
      command: NodeFS.realpathSync(NodePath.join(root, "bin", "launcher")),
      args: ["mcp"],
      env: {
        HOME: NodeOS.homedir(),
        ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
        TMPDIR: expect.stringMatching(/akeru-computer-use-/),
      },
    });
    if (typeof result.env?.TMPDIR === "string") directories.add(result.env.TMPDIR);
  });

  it("fails closed for unsupported, missing, disabled, and malformed plugins", async () => {
    await expect(
      resolveCodexComputerUseServer({ platform: "linux", run: async () => "" }),
    ).rejects.toThrow("only on macOS");
    await expect(
      resolveCodexComputerUseServer({
        platform: "darwin",
        run: async () => JSON.stringify({ installed: [], available: [] }),
      }),
    ).rejects.toThrow("codex plugin add");
    const root = plugin();
    await expect(
      resolveCodexComputerUseServer({
        platform: "darwin",
        run: async () => listing(root, { enabled: false }),
      }),
    ).rejects.toThrow("Enable");
    await expect(
      resolveCodexComputerUseServer({ platform: "darwin", run: async () => "not json" }),
    ).rejects.toThrow("invalid plugin list");
  });

  it("rejects a launcher outside the plugin directory", async () => {
    const root = plugin();
    const external = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-external-"));
    directories.add(external);
    const externalLauncher = NodePath.join(external, "launcher");
    NodeFS.writeFileSync(externalLauncher, "#!/bin/sh\n", { mode: 0o700 });
    NodeFS.rmSync(NodePath.join(root, "bin", "launcher"));
    NodeFS.symlinkSync(externalLauncher, NodePath.join(root, "bin", "launcher"));
    await expect(
      resolveCodexComputerUseServer({
        platform: "darwin",
        run: async () => listing(root),
      }),
    ).rejects.toThrow("escapes its plugin directory");
  });

  it("rejects a manifest outside the plugin directory", async () => {
    const root = plugin();
    const external = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-external-"));
    directories.add(external);
    const externalManifest = NodePath.join(external, ".mcp.json");
    NodeFS.renameSync(NodePath.join(root, ".mcp.json"), externalManifest);
    NodeFS.symlinkSync(externalManifest, NodePath.join(root, ".mcp.json"));

    await expect(
      resolveCodexComputerUseServer({
        platform: "darwin",
        run: async () => listing(root),
      }),
    ).rejects.toThrow("manifest escapes its plugin directory");
  });

  it("validates in-memory frames and removes temporary originals", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-frame-"));
    directories.add(directory);
    const path = NodePath.join(directory, "frame.png");
    const png = new PNG({ width: 1, height: 1 });
    png.data.fill(255);
    NodeFS.writeFileSync(path, PNG.sync.write(png));

    const result = sanitizeCodexComputerUseResult(
      {
        screenshot: { url: NodeURL.pathToFileURL(path).href },
      },
      { temporaryDirectory: directory },
    );

    expect(result).toMatchObject({
      screenshot: { url: expect.stringMatching(/^data:image\/png/) },
    });
    const frameUrl = (result as { screenshot: { url: string } }).screenshot.url;
    const frame = PNG.sync.read(
      Buffer.from(frameUrl.slice("data:image/png;base64,".length), "base64"),
    );
    expect([...frame.data]).toEqual([255, 255, 255, 255]);
    expect(NodeFS.existsSync(path)).toBe(false);

    const inline = sanitizeCodexComputerUseResult({
      type: "image",
      mimeType: "image/png",
      data: PNG.sync.write(png).toString("base64"),
    }) as { data: string };
    expect([...PNG.sync.read(Buffer.from(inline.data, "base64")).data]).toEqual([
      255, 255, 255, 255,
    ]);

    const missingPath = NodePath.join(directory, "private-window-title.png");
    expect(() =>
      sanitizeCodexComputerUseResult(
        {
          screenshot: { url: NodeURL.pathToFileURL(missingPath).href },
        },
        { temporaryDirectory: directory },
      ),
    ).toThrow("unreadable screenshot");
    try {
      sanitizeCodexComputerUseResult(
        {
          screenshot: { url: NodeURL.pathToFileURL(missingPath).href },
        },
        { temporaryDirectory: directory },
      );
    } catch (cause) {
      expect(String(cause)).not.toContain(missingPath);
    }

    expect(() =>
      sanitizeCodexComputerUseResult({
        type: "image",
        mimeType: "image/jpeg",
        data: "invalid",
      }),
    ).toThrow("unsupported screenshot format");
    expect(() =>
      sanitizeCodexComputerUseResult({
        type: "image",
        mimeType: "image/png",
        data: "A".repeat(28 * 1_024 * 1_024),
      }),
    ).toThrow("oversized screenshot");

    const foreignDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "foreign-frame-"));
    directories.add(foreignDirectory);
    const foreignPath = NodePath.join(foreignDirectory, "frame.png");
    NodeFS.writeFileSync(foreignPath, PNG.sync.write(png));
    expect(() =>
      sanitizeCodexComputerUseResult(
        { screenshot: { url: NodeURL.pathToFileURL(foreignPath).href } },
        { temporaryDirectory: directory },
      ),
    ).toThrow("outside its temporary directory");
    expect(NodeFS.existsSync(foreignPath)).toBe(true);
  });
});
