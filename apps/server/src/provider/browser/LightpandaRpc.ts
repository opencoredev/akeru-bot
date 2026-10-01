import * as Predicate from "effect/Predicate";
// @effect-diagnostics globalFetch:off nodeBuiltinImport:off
import * as NodeTimersPromises from "node:timers/promises";
import type { ToolsInput } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { redactSensitiveText } from "@akeru/shared/sensitiveDataRedaction";
import { z } from "zod";
import {
  type JsonRpcResponse,
  type BotBrowserRpc,
  type BotBrowserProcessInput,
  type BrowserRequestTransport,
  type BotBrowserAttachment,
} from "./BotBrowserTypes.ts";
import {
  type BrowserProcess,
  availableLocalPort,
  REMOTE_BROWSER_PORT,
  spawnRemoteBrowser,
  browserRequestTransport,
} from "./LightpandaProcess.ts";
import { installLightpanda, lightpandaMcpCommand } from "./LightpandaInstall.ts";

export const MAX_SNAPSHOT_LENGTH = 50 * 1_024;

export const MCP_PROTOCOL_VERSION = "2024-11-05";

export function browserRpcErrorMessage(error: NonNullable<JsonRpcResponse["error"]>): string {
  return redactSensitiveText(error.message ?? `Browser RPC ${error.code ?? "failed"}.`).value;
}

export function rpcResultText(value: unknown): string {
  if (!Predicate.isObjectOrArray(value) || value === null || !("content" in value)) {
    return JSON.stringify(value);
  }

  const content = value.content;

  if (!Array.isArray(content)) return JSON.stringify(value);

  return content
    .flatMap((item) => {
      if (!Predicate.isObjectOrArray(item) || item === null || !("text" in item)) return [];

      return Predicate.isString(item.text) ? [item.text] : [];
    })
    .join("\n");
}

export class LightpandaRpc implements BotBrowserRpc {
  private readonly input: BotBrowserProcessInput;
  private nextId = 1;
  private processes: BrowserProcess[] = [];
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
    try {
      const result = await this.request("tools/call", { name, arguments: arguments_ });

      if (name === "goto" || name === "click" || name === "fill") {
        await this.rememberCurrentUrl().catch(() => undefined);
      }

      this.input.onReady?.();

      return rpcResultText(result);
    } catch (error) {
      this.input.onFailure?.(error);
      throw error;
    }
  }

  async attachment(): Promise<BotBrowserAttachment | undefined> {
    try {
      await this.ensureStarted();

      return this.attachmentValue;
    } catch (error) {
      this.input.onFailure?.(error);
      throw error;
    }
  }

  async reconnect(): Promise<void> {
    if (this.closed) throw new Error(`Sandbox browser for '${this.input.threadId}' is closed.`);

    try {
      await this.stopProcesses();
    } catch (error) {
      this.input.onFailure?.(error);
      throw error;
    }
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

    if (!sandbox?.executeCommand) {
      throw new Error(`Workspace '${this.input.workspace.id}' cannot host a sandbox browser.`);
    }

    const local = sandbox.provider === "local";

    if (local && !sandbox.processes) {
      throw new Error(`Workspace '${this.input.workspace.id}' cannot host a sandbox browser.`);
    }

    if (!local && !this.input.browserEndpoint) {
      throw new Error(`Sandbox '${sandbox.provider}' has no Akeru browser adapter.`);
    }

    const binaryPath = await installLightpanda(sandbox, this.input.cacheDir);

    if (this.closed) throw new Error(`Sandbox browser for '${this.input.threadId}' is closed.`);
    const browserPort = local ? await availableLocalPort() : REMOTE_BROWSER_PORT;

    const endpoint = local
      ? { url: `http://127.0.0.1:${browserPort}`, requestHeaders: {} }
      : await this.input.browserEndpoint!(browserPort);

    const browserHandle = local
      ? await sandbox.processes!.spawn(lightpandaMcpCommand(binaryPath, browserPort, "127.0.0.1"), {
          maxRetainedBytes: 64 * 1_024,
        })
      : await spawnRemoteBrowser(sandbox, binaryPath, browserPort);

    const processes = [browserHandle];

    if (this.closed) {
      await Promise.all(processes.map((process) => process.kill().catch(() => false)));
      throw new Error(`Sandbox browser for '${this.input.threadId}' is closed.`);
    }

    this.processes = processes;

    try {
      this.requestTransport = browserRequestTransport(endpoint.url, endpoint.requestHeaders);
      await this.initialize();
      await this.restoreCurrentUrl();
      this.attachmentValue = {
        browserUrl: endpoint.url,
        mcpSessionId: this.sessionId!,
        requestHeaders: endpoint.requestHeaders,
        localRequestHeaders: endpoint.requestHeaders,
        availableToHostedPlugins: !local,
      };
      this.input.onReady?.();

      if (browserHandle.wait)
        void browserHandle.wait().then(
          () => this.processStopped(browserHandle),
          (error: unknown) => {
            if (!this.closed && this.processes.includes(browserHandle)) {
              this.input.onFailure?.(error);
            }
          },
        );
    } catch (cause) {
      this.processes = [];
      this.requestTransport = undefined;
      this.attachmentValue = undefined;
      this.sessionId = undefined;
      await Promise.all(processes.map((process) => process.kill().catch(() => false)));
      throw cause;
    }
  }

  private processStopped(process: BrowserProcess): void {
    if (this.closed || !this.processes.includes(process)) return;
    const remaining = this.processes.filter((candidate) => candidate !== process);
    this.processes = [];
    this.requestTransport = undefined;
    this.attachmentValue = undefined;
    this.sessionId = undefined;
    this.startPromise = undefined;
    void Promise.all(remaining.map((candidate) => candidate.kill().catch(() => false)));
    this.input.onFailure?.(new Error("The managed browser process exited."));
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
    const current = sessions.find((session) => Predicate.isString(session.url));

    if (Predicate.isString(current?.url) && current.url.length > 0) this.resumeUrl = current.url;
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
      throw new Error(browserRpcErrorMessage(parsed.error));
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

export const browserTargetSchema = z
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

        return {
          snapshot: snapshot.slice(0, MAX_SNAPSHOT_LENGTH),
          truncated: snapshot.length > MAX_SNAPSHOT_LENGTH,
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
