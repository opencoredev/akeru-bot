import type * as Cause from "effect/Cause";
import type * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type * as EffectAcpClient from "effect-acp/client";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpProtocol from "effect-acp/protocol";
import type * as EffectAcpSchema from "effect-acp/schema";
import type { AcpSessionModeState } from "./AcpRuntimeTypes.ts";
import type { AcpSessionRuntimeEvent } from "./AcpSessionEventTypes.ts";

export interface AcpSpawnInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface AcpSessionRuntimeOptions {
  readonly spawn: AcpSpawnInput;
  readonly cwd: string;
  readonly resumeSessionId?: string;
  readonly sessionLoadTimeout?: Duration.Input;
  readonly sessionLoadReplayIdleGap?: Duration.Input;
  readonly clientCapabilities?: EffectAcpSchema.InitializeRequest["clientCapabilities"];
  readonly clientInfo: {
    readonly name: string;
    readonly version: string;
  };
  readonly authMethodId: string;
  readonly mcpServers?: ReadonlyArray<EffectAcpSchema.McpServer>;
  readonly requestLogger?: (event: AcpSessionRequestLogEvent) => Effect.Effect<void, never>;
  readonly protocolLogging?: {
    readonly logIncoming?: boolean;
    readonly logOutgoing?: boolean;
    readonly logger?: (event: EffectAcpProtocol.AcpProtocolLogEvent) => Effect.Effect<void, never>;
  };
}

export interface AcpSessionRequestLogEvent {
  readonly method: string;
  readonly payload: unknown;
  readonly status: "started" | "succeeded" | "failed";
  readonly result?: unknown;
  readonly cause?: Cause.Cause<EffectAcpErrors.AcpError>;
}

export interface AcpSessionRuntimeStartResult {
  readonly sessionId: string;
  readonly initializeResult: EffectAcpSchema.InitializeResponse;
  readonly sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse;
  readonly modelConfigId: string | undefined;
}

export interface AcpSessionRuntimeShape {
  /**
   * Registers a handler for `session/request_permission`.
   * @see https://agentclientprotocol.com/protocol/schema#session/request_permission
   */
  readonly handleRequestPermission: EffectAcpClient.AcpClient["Service"]["handleRequestPermission"];
  /**
   * Registers a handler for `session/elicitation`.
   * @see https://agentclientprotocol.com/protocol/schema#session/elicitation
   */
  readonly handleElicitation: EffectAcpClient.AcpClient["Service"]["handleElicitation"];
  /**
   * Registers a handler for `fs/read_text_file`.
   * @see https://agentclientprotocol.com/protocol/schema#fs/read_text_file
   */
  readonly handleReadTextFile: EffectAcpClient.AcpClient["Service"]["handleReadTextFile"];
  /**
   * Registers a handler for `fs/write_text_file`.
   * @see https://agentclientprotocol.com/protocol/schema#fs/write_text_file
   */
  readonly handleWriteTextFile: EffectAcpClient.AcpClient["Service"]["handleWriteTextFile"];
  /**
   * Registers a handler for `terminal/create`.
   * @see https://agentclientprotocol.com/protocol/schema#terminal/create
   */
  readonly handleCreateTerminal: EffectAcpClient.AcpClient["Service"]["handleCreateTerminal"];
  /**
   * Registers a handler for `terminal/output`.
   * @see https://agentclientprotocol.com/protocol/schema#terminal/output
   */
  readonly handleTerminalOutput: EffectAcpClient.AcpClient["Service"]["handleTerminalOutput"];
  /**
   * Registers a handler for `terminal/wait_for_exit`.
   * @see https://agentclientprotocol.com/protocol/schema#terminal/wait_for_exit
   */
  readonly handleTerminalWaitForExit: EffectAcpClient.AcpClient["Service"]["handleTerminalWaitForExit"];
  /**
   * Registers a handler for `terminal/kill`.
   * @see https://agentclientprotocol.com/protocol/schema#terminal/kill
   */
  readonly handleTerminalKill: EffectAcpClient.AcpClient["Service"]["handleTerminalKill"];
  /**
   * Registers a handler for `terminal/release`.
   * @see https://agentclientprotocol.com/protocol/schema#terminal/release
   */
  readonly handleTerminalRelease: EffectAcpClient.AcpClient["Service"]["handleTerminalRelease"];
  /**
   * Registers a handler for `session/update`.
   * @see https://agentclientprotocol.com/protocol/schema#session/update
   */
  readonly handleSessionUpdate: EffectAcpClient.AcpClient["Service"]["handleSessionUpdate"];
  /**
   * Registers a handler for `session/elicitation/complete`.
   * @see https://agentclientprotocol.com/protocol/schema#session/elicitation/complete
   */
  readonly handleElicitationComplete: EffectAcpClient.AcpClient["Service"]["handleElicitationComplete"];
  /**
   * Registers a fallback extension request handler.
   * @see https://agentclientprotocol.com/protocol/extensibility
   */
  readonly handleUnknownExtRequest: EffectAcpClient.AcpClient["Service"]["handleUnknownExtRequest"];
  /**
   * Registers a fallback extension notification handler.
   * @see https://agentclientprotocol.com/protocol/extensibility
   */
  readonly handleUnknownExtNotification: EffectAcpClient.AcpClient["Service"]["handleUnknownExtNotification"];
  /**
   * Registers a typed extension request handler.
   * @see https://agentclientprotocol.com/protocol/extensibility
   */
  readonly handleExtRequest: EffectAcpClient.AcpClient["Service"]["handleExtRequest"];
  /**
   * Registers a typed extension notification handler.
   * @see https://agentclientprotocol.com/protocol/extensibility
   */
  readonly handleExtNotification: EffectAcpClient.AcpClient["Service"]["handleExtNotification"];
  /**
   * Sends ACP `initialize` without authenticating or opening a session.
   * Provider health checks use this to read advertised models from `_meta.modelState`.
   * @see https://agentclientprotocol.com/protocol/schema#initialize
   */
  readonly initialize: () => Effect.Effect<
    EffectAcpSchema.InitializeResponse,
    EffectAcpErrors.AcpError
  >;
  /**
   * Initializes the ACP connection, authenticates, and loads, resumes, or creates the session.
   * Concurrent calls share the same in-flight startup and a failed startup may be retried.
   */
  readonly start: () => Effect.Effect<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError>;
  /** Stream of parsed ACP session events emitted after startup. */
  readonly getEvents: () => Stream.Stream<AcpSessionRuntimeEvent, never>;
  /** Waits until the current event consumer has processed every queued event. */
  readonly drainEvents: Effect.Effect<void>;
  /** Latest mode state observed from session setup and `session/update` notifications. */
  readonly getModeState: Effect.Effect<AcpSessionModeState | undefined>;
  /** Latest configuration options observed from session setup and configuration writes. */
  readonly getConfigOptions: Effect.Effect<ReadonlyArray<EffectAcpSchema.SessionConfigOption>>;
  /**
   * Sends a prompt turn to the active session. `options.dispatched` settles once the
   * `session/prompt` RPC is registered as the active prompt, so a caller that forks this
   * effect knows when a later `cancel` will target this prompt.
   * @see https://agentclientprotocol.com/protocol/schema#session/prompt
   */
  readonly prompt: (
    payload: Omit<EffectAcpSchema.PromptRequest, "sessionId">,
    options?: { readonly dispatched?: Deferred.Deferred<void> },
  ) => Effect.Effect<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError>;
  /**
   * Sends a real ACP `session/cancel` notification for the active session.
   * @see https://agentclientprotocol.com/protocol/schema#session/cancel
   */
  readonly cancel: Effect.Effect<void, EffectAcpErrors.AcpError>;
  /**
   * Selects the active mode through the negotiated `mode` configuration option.
   * This is a no-op when the requested mode is already active.
   * @see https://agentclientprotocol.com/protocol/schema#session/set_config_option
   */
  readonly setMode: (
    modeId: string,
  ) => Effect.Effect<EffectAcpSchema.SetSessionModeResponse, EffectAcpErrors.AcpError>;
  /**
   * Updates a session configuration option and the runtime configuration snapshot.
   * @see https://agentclientprotocol.com/protocol/schema#session/set_config_option
   */
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<EffectAcpSchema.SetSessionConfigOptionResponse, EffectAcpErrors.AcpError>;
  /**
   * Selects the base model through the negotiated model configuration option.
   * @see https://agentclientprotocol.com/protocol/schema#session/set_config_option
   */
  readonly setModel: (model: string) => Effect.Effect<void, EffectAcpErrors.AcpError>;
  /**
   * Selects the active model through the unstable ACP `session/set_model` capability.
   * @see https://agentclientprotocol.com/protocol/schema#session/set_model
   */
  readonly setSessionModel: (
    modelId: string,
  ) => Effect.Effect<EffectAcpSchema.SetSessionModelResponse, EffectAcpErrors.AcpError>;
  /**
   * Sends a generic ACP extension request and records it through the request logger.
   * @see https://agentclientprotocol.com/protocol/extensibility
   */
  readonly request: EffectAcpClient.AcpClient["Service"]["raw"]["request"];
  /**
   * Sends a generic ACP extension notification.
   * @see https://agentclientprotocol.com/protocol/extensibility
   */
  readonly notify: EffectAcpClient.AcpClient["Service"]["raw"]["notify"];
}
