// @effect-diagnostics globalFetch:off nodeBuiltinImport:off
import { Workspace } from "@mastra/core/workspace";
import type { BotSandbox } from "@akeru/contracts";
import { WorkspaceComputer } from "../workspaceComputer.ts";

export const REMOTE_BOT_SANDBOXES = [
  "e2b",
  "daytona",
  "vercel",
  "upstash",
  "ascii",
  "railway",
  "tenki",
] as const;

export type RemoteBotSandbox = (typeof REMOTE_BOT_SANDBOXES)[number];

export type AkeruWorkspaceState = "running" | "sleeping" | "missing";

export interface AkeruBrowserEndpoint {
  readonly url: string;
  readonly requestHeaders: Readonly<Record<string, string>>;
}

export interface AkeruBotWorkspace {
  readonly id: string;
  readonly provider: BotSandbox;
  readonly providerId?: string;
  readonly computer?: WorkspaceComputer;
  readonly workspace: Workspace;
  readonly browserEndpoint?: (port: number) => Promise<AkeruBrowserEndpoint>;
  readonly inspect: () => Promise<AkeruWorkspaceState>;
  readonly wake: () => Promise<void>;
  readonly sleep: () => Promise<void>;
  readonly destroy: () => Promise<void>;
}

export interface AkeruRemoteSession {
  readonly providerId: string;
  readonly computer?: WorkspaceComputer;
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

export interface CreateRemoteBotWorkspaceInput {
  readonly threadId: string;
  readonly sandbox: RemoteBotSandbox;
  readonly identityFile?: string;
  readonly workspaceId?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly openSession?: (providerId?: string) => Promise<AkeruRemoteSession>;
}

export interface CreateBotWorkspaceInput {
  readonly threadId: string;
  readonly cwd?: string;
  readonly identityFile?: string;
  readonly localRoot?: string;
  readonly sandbox?: BotSandbox | null;
  readonly workspaceId?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly makeRemoteWorkspace?: (
    input: CreateRemoteBotWorkspaceInput,
  ) => Promise<AkeruBotWorkspace | Workspace>;
}
