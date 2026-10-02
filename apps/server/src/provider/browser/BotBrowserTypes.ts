import * as Schema from "effect/Schema";
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
  readonly call: (name: string, arguments_: BrowserRpcParams) => Promise<string>;
  readonly attachment: () => Promise<BotBrowserAttachment | undefined>;
  readonly reconnect: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface BotBrowserProcessInput {
  readonly threadId: string;
  readonly workspace: Workspace;
  readonly cacheDir: string;
  readonly browserEndpoint?: (port: number) => Promise<AkeruBrowserEndpoint>;
  readonly onFailure?: (cause: unknown) => void;
  readonly onReady?: () => void;
}

export interface CreateBotBrowserInput extends BotBrowserProcessInput {
  readonly makeRpc?: (input: BotBrowserProcessInput) => BotBrowserRpc;
}

export const JsonRpcResponseSchema = Schema.Struct({
  id: Schema.optional(Schema.Number),
  result: Schema.optional(Schema.Json),
  error: Schema.optional(
    Schema.Struct({
      code: Schema.optional(Schema.Number),
      message: Schema.optional(Schema.String),
    }),
  ),
});

export type JsonRpcResponse = typeof JsonRpcResponseSchema.Type;

export type BrowserRpcValue =
  | Schema.Json
  | undefined
  | readonly BrowserRpcValue[]
  | { readonly [key: string]: BrowserRpcValue };

export type BrowserRpcParams = Readonly<Record<string, BrowserRpcValue>>;

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
