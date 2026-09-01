// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import type { McpServerConfig } from "@mastra/code-sdk/mcp/index";

import { MAX_SCREENSHOT_BYTES, redactComputerScreenshot } from "../mcp/PreviewSnapshotRedaction.ts";

export const CODEX_COMPUTER_USE_SERVER_ID = "builtin-computer-use";
const CODEX_COMPUTER_USE_PLUGIN_ID = "computer-use@openai-bundled";
const MAX_SCREENSHOT_BASE64_LENGTH = Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4;
const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

type RunCodex = (args: readonly string[]) => Promise<string>;
export interface CodexComputerUseServerConfig {
  readonly command: string;
  readonly args: string[];
  readonly env: Record<string, string>;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function entries(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Codex returned an invalid plugin list.");
  return value.map((entry) => object(entry, "Codex plugin entry"));
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is invalid.`);
  return value;
}

async function runCodex(args: readonly string[]): Promise<string> {
  const result = await execFile("codex", [...args], {
    encoding: "utf8",
    timeout: 10_000,
    killSignal: "SIGKILL",
    maxBuffer: 2 * 1_024 * 1_024,
  });
  return result.stdout;
}

export function isCodexComputerUseServer(id: string): boolean {
  return id === CODEX_COMPUTER_USE_SERVER_ID;
}

export function isCodexComputerUseTool(name: string): boolean {
  return name.startsWith(`${CODEX_COMPUTER_USE_SERVER_ID}_`);
}

function isWithin(parent: string, child: string): boolean {
  const relative = NodePath.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
}

function screenshotDataUrl(url: string, temporaryDirectory?: string): string {
  if (url.startsWith("data:image/png;base64,")) {
    const encoded = url.slice("data:image/png;base64,".length);
    if (encoded.length > MAX_SCREENSHOT_BASE64_LENGTH) {
      throw new Error("Computer Use returned an oversized screenshot.");
    }
    const redacted = redactComputerScreenshot({
      mediaType: "image/png",
      data: Buffer.from(encoded, "base64"),
    });
    return `data:image/png;base64,${Buffer.from(redacted.data).toString("base64")}`;
  }
  if (!url.startsWith("file:")) throw new Error("Computer Use returned an unknown screenshot.");
  if (!temporaryDirectory) throw new Error("Computer Use screenshot cleanup is unavailable.");
  let path: string;
  let ownedDirectory: string;
  try {
    path = NodeFS.realpathSync(NodeURL.fileURLToPath(url));
    ownedDirectory = NodeFS.realpathSync(temporaryDirectory);
  } catch {
    throw new Error("Computer Use returned an unreadable screenshot.");
  }
  if (!isWithin(ownedDirectory, path)) {
    throw new Error("Computer Use returned a screenshot outside its temporary directory.");
  }
  let bytes: Buffer | undefined;
  try {
    const redacted = redactComputerScreenshot({
      mediaType: "image/png",
      data: NodeFS.readFileSync(path),
    });
    bytes = Buffer.from(redacted.data);
  } catch {
    bytes = undefined;
  }
  try {
    NodeFS.rmSync(path);
  } catch {
    throw new Error("Could not remove the temporary Computer Use screenshot.");
  }
  if (!bytes) throw new Error("Computer Use returned an invalid screenshot.");
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

export function sanitizeCodexComputerUseResult(
  value: unknown,
  options?: { readonly temporaryDirectory?: string },
): unknown {
  let remaining = 10_000;
  const visit = (entry: unknown, field?: string): unknown => {
    remaining -= 1;
    if (remaining < 0) throw new Error("Computer Use returned too much data.");
    if (Array.isArray(entry)) return entry.map((item) => visit(item));
    if (typeof entry !== "object" || entry === null) {
      if (field === "screenshot" && entry !== null) {
        throw new Error("Computer Use returned an invalid screenshot.");
      }
      return entry;
    }
    const object = entry as Record<string, unknown>;
    if (object.type === "image") {
      const mediaType = object.mimeType ?? object.mediaType;
      if (mediaType !== "image/png" || typeof object.data !== "string") {
        throw new Error("Computer Use returned an unsupported screenshot format.");
      }
      if (object.data.length > MAX_SCREENSHOT_BASE64_LENGTH) {
        throw new Error("Computer Use returned an oversized screenshot.");
      }
      const redacted = redactComputerScreenshot({
        mediaType: "image/png",
        data: Buffer.from(object.data, "base64"),
      });
      return { ...object, data: Buffer.from(redacted.data).toString("base64") };
    }
    if (field === "screenshot") {
      if (typeof object.url !== "string") {
        throw new Error("Computer Use returned an invalid screenshot.");
      }
      return { ...object, url: screenshotDataUrl(object.url, options?.temporaryDirectory) };
    }
    return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, visit(item, key)]));
  };
  return visit(value);
}

export async function resolveCodexComputerUseServer(options: {
  readonly platform: NodeJS.Platform;
  readonly run?: RunCodex;
}): Promise<CodexComputerUseServerConfig> {
  if (options.platform !== "darwin") {
    throw new Error("Codex Computer Use is supported only on macOS.");
  }

  let output: string;
  try {
    output = await (options.run ?? runCodex)([
      "plugin",
      "list",
      "--marketplace",
      "openai-bundled",
      "--available",
      "--json",
    ]);
  } catch {
    throw new Error("Could not inspect the Codex Computer Use plugin.");
  }

  let document: Record<string, unknown>;
  try {
    document = object(JSON.parse(output), "Codex plugin list");
  } catch {
    throw new Error("Codex returned an invalid plugin list.");
  }
  const plugin = [...entries(document.installed), ...entries(document.available)].find(
    (entry) => entry.pluginId === CODEX_COMPUTER_USE_PLUGIN_ID,
  );
  if (!plugin || plugin.installed !== true) {
    throw new Error(
      "Install the official Codex Computer Use plugin with `codex plugin add computer-use@openai-bundled --json`.",
    );
  }
  if (plugin.enabled !== true) throw new Error("Enable the official Codex Computer Use plugin.");

  const source = object(plugin.source, "Codex Computer Use plugin source");
  if (source.source !== "local") throw new Error("Codex Computer Use must use a local plugin.");
  let root: string;
  let manifestPath: string;
  let manifest: Record<string, unknown>;
  try {
    root = NodeFS.realpathSync(string(source.path, "Codex Computer Use plugin path"));
    manifestPath = NodeFS.realpathSync(NodePath.join(root, ".mcp.json"));
    if (!isWithin(root, manifestPath)) {
      throw new Error("Computer Use MCP manifest escapes its plugin directory.");
    }
    manifest = object(JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")), "MCP manifest");
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes("escapes its plugin directory")) {
      throw cause;
    }
    // eslint-disable-next-line preserve-caught-error -- Plugin paths must not reach persisted errors.
    throw new Error("Could not read the Codex Computer Use plugin.");
  }
  const servers = object(manifest.mcpServers, "MCP servers");
  const server = object(servers["computer-use"], "Computer Use MCP server");
  const command = string(server.command, "Computer Use MCP command");
  if (NodePath.isAbsolute(command) || server.cwd !== ".") {
    throw new Error("Computer Use MCP must use its plugin-relative launcher.");
  }
  if (
    !Array.isArray(server.args) ||
    server.args.length !== 1 ||
    server.args[0] !== "mcp" ||
    !Array.isArray(server.env_vars) ||
    server.env_vars.length !== 1 ||
    server.env_vars[0] !== "CODEX_HOME"
  ) {
    throw new Error("Computer Use MCP has an unsupported launch configuration.");
  }

  let launcher: string;
  try {
    launcher = NodeFS.realpathSync(NodePath.resolve(root, command));
    NodeFS.accessSync(launcher, NodeFS.constants.X_OK);
  } catch {
    throw new Error("Could not start the Codex Computer Use plugin.");
  }
  if (!isWithin(root, launcher)) {
    throw new Error("Computer Use MCP launcher escapes its plugin directory.");
  }
  return {
    command: launcher,
    args: ["mcp"],
    env: {
      HOME: NodeOS.homedir(),
      ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
      TMPDIR: NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-computer-use-")),
    },
  } satisfies McpServerConfig;
}
