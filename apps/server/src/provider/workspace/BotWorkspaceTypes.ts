import type { BotWorkspaceIO } from "./BotWorkspaceIO.ts";
import { Workspace } from "@mastra/core/workspace";
import type { BotSandbox } from "@akeru/contracts";
import type { Files } from "@opencoredev/sandbox-sdk";
import type { SandboxBinding } from "./SandboxProviders.ts";
import { WorkspaceComputer } from "../workspaceComputer.ts";

export const REMOTE_BOT_SANDBOXES = [
  "e2b",
  "daytona",
  "vercel",
  "upstash",
  "ascii",
  "railway",
  "tenki",
  "boat",
  "docker",
] as const;

export type RemoteBotSandbox = (typeof REMOTE_BOT_SANDBOXES)[number];

export type AkeruWorkspaceState = "running" | "sleeping" | "missing";

export interface AkeruBrowserEndpoint {
  readonly url: string;
  readonly requestHeaders: Readonly<Record<string, string>>;
  /**
   * `true` when only the environment computer can reach `url` (Local Docker's published
   * ports). Hosted connectors never receive such an endpoint.
   */
  readonly loopback?: boolean;
}

/**
 * What a workspace can do, read from the sandbox-sdk handle. The pool only pauses
 * workspaces that can pause, and drops a handle that failed to wake when the
 * workspace can be reattached by its saved ID.
 */
export interface AkeruWorkspaceCapabilities {
  readonly pause: boolean;
  readonly snapshot: boolean;
  readonly browser: boolean;
  readonly reconnect: boolean;
}

export interface AkeruBotWorkspace {
  readonly id: string;
  readonly provider: BotSandbox;
  readonly providerId?: string;
  /**
   * `true` when this open created the sandbox, `false` when it reattached by saved ID.
   * Failed session setup never destroys a reattached sandbox.
   */
  readonly created?: boolean;
  readonly capabilities?: AkeruWorkspaceCapabilities;
  readonly computer?: WorkspaceComputer;
  readonly workspace: Workspace;
  readonly browserEndpoint?: (port: number) => Promise<AkeruBrowserEndpoint>;
  readonly inspect: () => Promise<AkeruWorkspaceState>;
  readonly wake: () => Promise<void>;
  readonly sleep: () => Promise<void>;
  readonly destroy: () => Promise<void>;
}

/** The sandbox-sdk file calls a remote workspace filesystem uses. */
export type AkeruSandboxFiles = Pick<
  Files,
  "read" | "write" | "list" | "stat" | "exists" | "remove"
>;

export interface AkeruRemoteSession {
  readonly providerId: string;
  readonly capabilities?: AkeruWorkspaceCapabilities;
  readonly computer?: WorkspaceComputer;
  readonly files: AkeruSandboxFiles;
  /** Where commands start and relative file paths resolve. Defaults to `/workspace`. */
  readonly workdir?: string;
  /** When set, commands run as this user and files written are owned by it. */
  readonly user?: string;
  readonly inspect: () => Promise<AkeruWorkspaceState>;
  readonly run: (
    command: string,
    args: readonly string[],
    options?: { cwd?: string; env?: Record<string, string>; timeout?: number },
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readonly browserEndpoint: (port: number) => Promise<AkeruBrowserEndpoint>;
  readonly wake: () => Promise<void>;
  readonly sleep: () => Promise<void>;
  readonly destroy: () => Promise<void>;
}

/**
 * A cleanup request to reach a key's saved sandbox. It never creates one: with no saved ID, or
 * a saved ID other than `providerId` when given, there is nothing to clean up.
 */
export interface BotWorkspaceReattach {
  readonly providerId?: string;
}

export interface CreateRemoteBotWorkspaceInput {
  readonly io: BotWorkspaceIO;
  readonly threadId: string;
  readonly sandbox: RemoteBotSandbox;
  readonly identityFile?: string;
  readonly workspaceId?: string;
  readonly environment?: Readonly<Record<string, string>>;
  /** Replaces the configured sandbox-sdk provider and its rules, for tests against `memory()`. */
  readonly sandboxBinding?: SandboxBinding;
  readonly openSession?: (providerId?: string) => Promise<AkeruRemoteSession>;
  /** Set by cleanup: fail rather than create a sandbox when the saved one is gone or different. */
  readonly reattach?: BotWorkspaceReattach;
}

export interface CreateBotWorkspaceInput {
  readonly io: BotWorkspaceIO;
  readonly threadId: string;
  readonly cwd?: string;
  readonly identityFile?: string;
  readonly localRoot?: string;
  readonly sandbox?: BotSandbox | null;
  readonly workspaceId?: string;
  readonly environment?: Readonly<Record<string, string>>;
  /** Set by cleanup: resolve nothing, rather than create, when no matching sandbox is saved. */
  readonly reattach?: BotWorkspaceReattach;
  readonly makeRemoteWorkspace?: (
    input: CreateRemoteBotWorkspaceInput,
  ) => Promise<AkeruBotWorkspace | Workspace>;
}
