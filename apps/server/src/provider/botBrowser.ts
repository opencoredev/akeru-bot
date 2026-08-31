// @effect-diagnostics nodeBuiltinImport:off
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

import type { ToolsInput } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import type { ProcessHandle, Workspace, WorkspaceSandbox } from "@mastra/core/workspace";
import { z } from "zod";

import { redactSensitiveText } from "../mcp/SensitiveDataRedaction.ts";

const LIGHTPANDA_VERSION = "0.3.7";
const MAX_SNAPSHOT_LENGTH = 50 * 1_024;
const MCP_PROTOCOL_VERSION = "2024-11-05";
const BROWSER_REQUEST_TIMEOUT_MS = 30_000;

interface LightpandaRelease {
  readonly url: string;
  readonly sha256: string;
}

const LIGHTPANDA_RELEASES = {
  "darwin-arm64": {
    url: `https://github.com/lightpanda-io/browser/releases/download/${LIGHTPANDA_VERSION}/lightpanda-aarch64-macos`,
    sha256: "ae99542d81af23087296ec037abb0d57a57002502f5ff4c1b0b05dfa484b79b8",
  },
  "darwin-x64": {
    url: `https://github.com/lightpanda-io/browser/releases/download/${LIGHTPANDA_VERSION}/lightpanda-x86_64-macos`,
    sha256: "5e118b6e91c2cccb1ce7f0d34fc39dab262b947e4dea29a90b1a75b9399d7862",
  },
  "linux-arm64": {
    url: `https://github.com/lightpanda-io/browser/releases/download/${LIGHTPANDA_VERSION}/lightpanda-aarch64-linux`,
    sha256: "4c0ecb28b4fcfb6d5bce82ec86e15fc6cde89cea168cf3840494f0ee26755852",
  },
  "linux-x64": {
    url: `https://github.com/lightpanda-io/browser/releases/download/${LIGHTPANDA_VERSION}/lightpanda-x86_64-linux`,
    sha256: "895339b02205171a181dde743ae0068bb4564884076feac8482baca9c212aa5a",
  },
} as const satisfies Readonly<Record<string, LightpandaRelease>>;

type LightpandaPlatform = keyof typeof LIGHTPANDA_RELEASES;

export interface BotBrowserAttachment {
  readonly browserUrl: string;
  readonly mcpSessionId: string;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly localRequestHeaders: Readonly<Record<string, string>>;
  readonly availableToHostedPlugins: boolean;
}

export interface BotBrowser {
  readonly tools: ToolsInput;
  readonly attachment: () => Promise<BotBrowserAttachment | undefined>;
  readonly reconnect: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface BotBrowserRpc {
  readonly call: (name: string, arguments_: Readonly<Record<string, unknown>>) => Promise<string>;
  readonly attachment: () => Promise<BotBrowserAttachment | undefined>;
  readonly reconnect: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface CreateBotBrowserInput {
  readonly threadId: string;
  readonly workspace: Workspace;
  readonly cacheDir: string;
  readonly makeRpc?: (input: BotBrowserProcessInput) => BotBrowserRpc;
}

export interface BotBrowserProcessInput {
  readonly threadId: string;
  readonly workspace: Workspace;
  readonly cacheDir: string;
}

interface JsonRpcResponse {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

export interface BrowserHttpResponse {
  readonly status: number;
  readonly body: string;
  readonly sessionId?: string;
}

export interface BrowserRequest {
  readonly method: "POST" | "DELETE";
  readonly body?: string;
  readonly sessionId?: string;
}

type BrowserRequestTransport = (request: BrowserRequest) => Promise<BrowserHttpResponse>;

function platformFromUname(system: string, machine: string): LightpandaPlatform {
  const os = system.trim().toLowerCase();
  const arch = machine.trim().toLowerCase();
  const normalizedOs = os === "darwin" ? "darwin" : os === "linux" ? "linux" : null;
  const normalizedArch =
    arch === "arm64" || arch === "aarch64"
      ? "arm64"
      : arch === "x86_64" || arch === "amd64"
        ? "x64"
        : null;
  const key = normalizedOs && normalizedArch ? `${normalizedOs}-${normalizedArch}` : null;
  if (!key || !(key in LIGHTPANDA_RELEASES)) {
    throw new Error(`The sandbox browser does not support ${system.trim()} ${machine.trim()}.`);
  }
  return key as LightpandaPlatform;
}

async function execute(
  sandbox: WorkspaceSandbox,
  command: string,
  args: string[],
  timeout = 30_000,
): Promise<string> {
  if (!sandbox.executeCommand) {
    throw new Error(`Sandbox '${sandbox.provider}' cannot run browser commands.`);
  }
  const result = await sandbox.executeCommand(command, args, { timeout });
  if (!result.success) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
    throw new Error(`Sandbox browser command '${command}' failed: ${detail}`);
  }
  return result.stdout;
}

async function isExecutable(sandbox: WorkspaceSandbox, path: string): Promise<boolean> {
  if (!sandbox.executeCommand) return false;
  const result = await sandbox.executeCommand("test", ["-x", path], { timeout: 5_000 });
  return result.success;
}

const lightpandaInstalls = new Map<string, Promise<string>>();

async function installLightpanda(sandbox: WorkspaceSandbox, cacheDir: string): Promise<string> {
  const system = await execute(sandbox, "uname", ["-s"]);
  const machine = await execute(sandbox, "uname", ["-m"]);
  const platform = platformFromUname(system, machine);
  const release = LIGHTPANDA_RELEASES[platform];
  const root = sandbox.provider === "local" ? cacheDir : `/tmp/akeru-browser-${LIGHTPANDA_VERSION}`;
  const binaryPath = NodePath.posix.join(root, "lightpanda");
  const installKey = sandbox.provider === "local" ? binaryPath : `${sandbox.id}:${binaryPath}`;
  const activeInstall = lightpandaInstalls.get(installKey);
  if (activeInstall) return activeInstall;

  const install = (async () => {
    if (await isExecutable(sandbox, binaryPath)) return binaryPath;
    const temporaryPath = `${binaryPath}.download`;
    await execute(sandbox, "mkdir", ["-p", root]);
    await execute(
      sandbox,
      "curl",
      ["-fsSL", "--retry", "2", release.url, "-o", temporaryPath],
      300_000,
    );
    const hashCommand = platform.startsWith("darwin-") ? "shasum" : "sha256sum";
    const hashArgs = platform.startsWith("darwin-")
      ? ["-a", "256", temporaryPath]
      : [temporaryPath];
    const actualHash = (await execute(sandbox, hashCommand, hashArgs)).trim().split(/\s+/)[0];
    if (actualHash !== release.sha256) {
      await sandbox.executeCommand?.("rm", ["-f", temporaryPath], { timeout: 5_000 });
      throw new Error(`Sandbox browser download failed integrity verification for ${platform}.`);
    }
    await execute(sandbox, "chmod", ["700", temporaryPath]);
    await execute(sandbox, "mv", [temporaryPath, binaryPath]);
    return binaryPath;
  })();
  lightpandaInstalls.set(installKey, install);
  try {
    return await install;
  } finally {
    lightpandaInstalls.delete(installKey);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function lightpandaMcpCommand(binaryPath: string, port: number, host = "0.0.0.0"): string {
  return `${shellQuote(binaryPath)} mcp --host ${shellQuote(host)} --port ${port}`;
}

function availableLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a local sandbox browser port."));
        return;
      }
      const port = address.port;
      server.close((cause) => (cause ? reject(cause) : resolve(port)));
    });
  });
}

function browserRequestTransport(url: string): BrowserRequestTransport {
  return async (request) => {
    // This runtime is owned by Mastra's promise-based workspace API, not an Effect layer.
    // @effect-diagnostics-next-line globalFetch:off
    const response = await fetch(url, {
      method: request.method,
      headers: {
        accept: "application/json, text/event-stream",
        ...(request.method === "POST" ? { "content-type": "application/json" } : {}),
        ...(request.sessionId ? { "mcp-session-id": request.sessionId } : {}),
      },
      ...(request.body ? { body: request.body } : {}),
      signal: AbortSignal.timeout(BROWSER_REQUEST_TIMEOUT_MS),
    });
    const sessionId = response.headers.get("mcp-session-id");
    return {
      status: response.status,
      body: await response.text(),
      ...(sessionId ? { sessionId } : {}),
    };
  };
}

function rpcResultText(value: unknown): string {
  if (typeof value !== "object" || value === null || !("content" in value)) {
    return JSON.stringify(value);
  }
  const content = value.content;
  if (!Array.isArray(content)) return JSON.stringify(value);
  return content
    .flatMap((item) => {
      if (typeof item !== "object" || item === null || !("text" in item)) return [];
      return typeof item.text === "string" ? [item.text] : [];
    })
    .join("\n");
}

class LightpandaRpc implements BotBrowserRpc {
  private readonly input: BotBrowserProcessInput;
  private nextId = 1;
  private processes: ProcessHandle[] = [];
  private startPromise: Promise<void> | undefined;
  private requestTransport: BrowserRequestTransport | undefined;
  private attachmentValue: BotBrowserAttachment | undefined;
  private sessionId: string | undefined;
  private resumeUrl: string | undefined;
  private closed = false;

  constructor(input: BotBrowserProcessInput) {
    this.input = input;
  }

  async call(name: string, arguments_: Readonly<Record<string, unknown>>): Promise<string> {
    const result = await this.request("tools/call", { name, arguments: arguments_ });
    if (name === "goto" || name === "click" || name === "fill") {
      await this.rememberCurrentUrl().catch(() => undefined);
    }
    return rpcResultText(result);
  }

  async attachment(): Promise<BotBrowserAttachment | undefined> {
    await this.ensureStarted();
    return this.attachmentValue;
  }

  async reconnect(): Promise<void> {
    if (this.closed) throw new Error(`Sandbox browser for '${this.input.threadId}' is closed.`);
    await this.stopProcesses();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.stopProcesses();
  }

  private async ensureStarted(): Promise<void> {
    if (this.closed) throw new Error(`Sandbox browser for '${this.input.threadId}' is closed.`);
    this.startPromise ??= this.start().catch((cause: unknown) => {
      this.startPromise = undefined;
      throw cause;
    });
    return this.startPromise;
  }

  private async start(): Promise<void> {
    const sandbox = this.input.workspace.sandbox;
    if (!sandbox?.processes) {
      throw new Error(`Workspace '${this.input.workspace.id}' cannot host a sandbox browser.`);
    }
    if (sandbox.provider !== "local") {
      throw new Error(`Sandbox '${sandbox.provider}' has no Akeru browser adapter.`);
    }
    const binaryPath = await installLightpanda(sandbox, this.input.cacheDir);
    if (this.closed) throw new Error(`Sandbox browser for '${this.input.threadId}' is closed.`);
    const browserPort = await availableLocalPort();
    const browserHandle = await sandbox.processes.spawn(
      lightpandaMcpCommand(binaryPath, browserPort, "127.0.0.1"),
      { maxRetainedBytes: 64 * 1_024 },
    );
    const processes = [browserHandle];
    if (this.closed) {
      await Promise.all(processes.map((process) => process.kill().catch(() => false)));
      throw new Error(`Sandbox browser for '${this.input.threadId}' is closed.`);
    }
    this.processes = processes;
    for (const process of processes) {
      void process.wait().then(() => this.processStopped(process));
    }

    try {
      const browserUrl = `http://127.0.0.1:${browserPort}`;
      this.requestTransport = browserRequestTransport(browserUrl);
      await this.initialize();
      await this.restoreCurrentUrl();
      this.attachmentValue = {
        browserUrl,
        mcpSessionId: this.sessionId!,
        requestHeaders: {},
        localRequestHeaders: {},
        availableToHostedPlugins: false,
      };
    } catch (cause) {
      this.processes = [];
      this.requestTransport = undefined;
      this.attachmentValue = undefined;
      this.sessionId = undefined;
      await Promise.all(processes.map((process) => process.kill().catch(() => false)));
      throw cause;
    }
  }

  private processStopped(process: ProcessHandle): void {
    if (this.closed || !this.processes.includes(process)) return;
    const remaining = this.processes.filter((candidate) => candidate !== process);
    this.processes = [];
    this.requestTransport = undefined;
    this.attachmentValue = undefined;
    this.sessionId = undefined;
    this.startPromise = undefined;
    void Promise.all(remaining.map((candidate) => candidate.kill().catch(() => false)));
  }

  private async stopProcesses(): Promise<void> {
    const transport = this.requestTransport;
    const sessionId = this.sessionId;
    const processes = this.processes;
    this.processes = [];
    this.requestTransport = undefined;
    this.attachmentValue = undefined;
    this.sessionId = undefined;
    this.startPromise = undefined;
    if (transport && sessionId) {
      await transport({ method: "DELETE", sessionId }).catch(() => undefined);
    }
    await Promise.all(processes.map((process) => process.kill().catch(() => false)));
  }

  private async rememberCurrentUrl(): Promise<void> {
    const result = await this.send("tools/call", { name: "session_list", arguments: {} });
    const text = rpcResultText(result.result);
    const sessions = JSON.parse(text) as ReadonlyArray<{ readonly url?: unknown }>;
    const current = sessions.find((session) => typeof session.url === "string");
    if (typeof current?.url === "string" && current.url.length > 0) this.resumeUrl = current.url;
  }

  private async restoreCurrentUrl(): Promise<void> {
    if (!this.resumeUrl) return;
    await this.send("tools/call", { name: "goto", arguments: { url: this.resumeUrl } });
  }

  private async initialize(): Promise<void> {
    let lastCause: unknown;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const response = await this.send("initialize", {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "akeru", version: "1.0.0" },
        });
        if (!response.sessionId) throw new Error("Sandbox browser did not create an MCP session.");
        this.sessionId = response.sessionId;
        await this.sendNotification("notifications/initialized");
        return;
      } catch (cause) {
        lastCause = cause;
        await NodeTimersPromises.setTimeout(100);
      }
    }
    throw lastCause instanceof Error
      ? lastCause
      : new Error("Sandbox browser did not become ready.");
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    await this.ensureStarted();
    return (await this.send(method, params)).result;
  }

  private async send(
    method: string,
    params: unknown,
  ): Promise<{ readonly result: unknown; readonly sessionId?: string }> {
    const transport = this.requestTransport;
    if (!transport) throw new Error("Sandbox browser HTTP transport is not ready.");
    const id = this.nextId++;
    const response = await transport({
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Sandbox browser HTTP request failed with status ${response.status}.`);
    }
    const parsed = JSON.parse(response.body) as JsonRpcResponse;
    if (parsed.error) {
      throw new Error(parsed.error.message ?? `Browser RPC ${parsed.error.code ?? "failed"}.`);
    }
    return {
      result: parsed.result,
      ...(response.sessionId ? { sessionId: response.sessionId } : {}),
    };
  }

  private async sendNotification(method: string): Promise<void> {
    const transport = this.requestTransport;
    if (!transport) throw new Error("Sandbox browser HTTP transport is not ready.");
    const response = await transport({
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", method }),
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Sandbox browser notification failed with status ${response.status}.`);
    }
  }
}

const browserTargetSchema = z
  .object({
    selector: z.string().trim().min(1).optional(),
    backendNodeId: z.number().int().positive().optional(),
  })
  .refine((input) => input.selector !== undefined || input.backendNodeId !== undefined, {
    message: "Provide selector or backendNodeId.",
  });

export function createBotBrowserTools(rpc: BotBrowserRpc): ToolsInput {
  const call = async (name: string, input: Readonly<Record<string, unknown>>) =>
    redactSensitiveText(await rpc.call(name, input)).value;

  return {
    browser_navigate: createTool({
      id: "browser_navigate",
      description: "Navigate the browser inside the active sandbox to one URL.",
      inputSchema: z.object({ url: z.url() }),
      execute: async ({ url }) => ({ result: await call("goto", { url }) }),
    }),
    browser_snapshot: createTool({
      id: "browser_snapshot",
      description:
        "Read the current sandbox browser page as a semantic tree with selectors and backend node ids.",
      inputSchema: z.object({}),
      execute: async () => {
        const snapshot = await call("tree", {});
        const redacted = redactSensitiveText(snapshot).value;
        return {
          snapshot: redacted.slice(0, MAX_SNAPSHOT_LENGTH),
          truncated: redacted.length > MAX_SNAPSHOT_LENGTH,
        };
      },
    }),
    browser_click: createTool({
      id: "browser_click",
      description: "Click one element in the current sandbox browser page.",
      inputSchema: browserTargetSchema,
      execute: async (input) => ({ result: await call("click", input) }),
    }),
    browser_type: createTool({
      id: "browser_type",
      description: "Replace the text in one field in the current sandbox browser page.",
      inputSchema: browserTargetSchema.extend({ text: z.string() }),
      execute: async ({ text, ...target }) => ({
        result: await call("fill", { ...target, value: text }),
      }),
    }),
  };
}

export function createBotBrowser(input: CreateBotBrowserInput): BotBrowser {
  const rpc = input.makeRpc?.(input) ?? new LightpandaRpc(input);
  return {
    tools: createBotBrowserTools(rpc),
    attachment: () => rpc.attachment(),
    reconnect: () => rpc.reconnect(),
    close: () => rpc.close(),
  };
}
