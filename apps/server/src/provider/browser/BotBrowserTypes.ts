// @effect-diagnostics globalFetch:off nodeBuiltinImport:off
import type { ToolsInput } from "@mastra/core/agent";
import type { Workspace } from "@mastra/core/workspace";
import type { AkeruBrowserEndpoint } from "../workspace/BotWorkspaceTypes.ts";

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

export interface BotBrowserProcessInput {
  readonly threadId: string;
  readonly workspace: Workspace;
  readonly cacheDir: string;
  readonly browserEndpoint?: (port: number) => Promise<AkeruBrowserEndpoint>;
  readonly onFailure?: (error: unknown) => void;
  readonly onReady?: () => void;
}

export interface CreateBotBrowserInput extends BotBrowserProcessInput {
  readonly makeRpc?: (input: BotBrowserProcessInput) => BotBrowserRpc;
}

export interface JsonRpcResponse {
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

export type BrowserRequestTransport = (request: BrowserRequest) => Promise<BrowserHttpResponse>;
