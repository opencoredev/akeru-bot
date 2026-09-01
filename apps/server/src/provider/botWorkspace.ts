// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { TOOL_NAME_OVERRIDES } from "@mastra/code-sdk/tool-names";
import {
  type CommandResult,
  type ExecuteCommandOptions,
  LocalFilesystem,
  LocalSandbox,
  MastraSandbox,
  type ProviderStatus,
  Workspace,
} from "@mastra/core/workspace";
import type { BotSandbox } from "@t3tools/contracts";
import { BotWorkspaceFilesystem } from "./botWorkspaceFilesystem.ts";

export const REMOTE_BOT_SANDBOXES = ["e2b", "daytona", "vercel", "upstash"] as const;
export type RemoteBotSandbox = (typeof REMOTE_BOT_SANDBOXES)[number];
export type AkeruWorkspaceState = "running" | "sleeping" | "missing";

export interface AkeruBotWorkspace {
  readonly id: string;
  readonly provider: BotSandbox;
  readonly providerId?: string;
  readonly workspace: Workspace;
  readonly inspect: () => Promise<AkeruWorkspaceState>;
  readonly wake: () => Promise<void>;
  readonly sleep: () => Promise<void>;
  readonly destroy: () => Promise<void>;
}

export interface AkeruRemoteSession {
  readonly providerId: string;
  readonly inspect: () => Promise<AkeruWorkspaceState>;
  readonly run: (
    command: string,
    args: readonly string[],
    options?: { cwd?: string; env?: Record<string, string>; timeout?: number },
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readonly wake: () => Promise<void>;
  readonly sleep: () => Promise<void>;
  readonly destroy: () => Promise<void>;
}

export interface CreateRemoteBotWorkspaceInput {
  readonly threadId: string;
  readonly sandbox: RemoteBotSandbox;
  readonly identityFile?: string;
  readonly workspaceId?: string;
  readonly openSession?: (providerId?: string) => Promise<AkeruRemoteSession>;
}

export interface CreateBotWorkspaceInput {
  readonly threadId: string;
  readonly cwd?: string;
  readonly identityFile?: string;
  readonly localRoot?: string;
  readonly sandbox?: BotSandbox | null;
  readonly workspaceId?: string;
  readonly makeRemoteWorkspace?: (
    input: CreateRemoteBotWorkspaceInput,
  ) => Promise<AkeruBotWorkspace | Workspace>;
}

export function isRemoteBotSandbox(
  value: BotSandbox | null | undefined,
): value is RemoteBotSandbox {
  return REMOTE_BOT_SANDBOXES.some((provider) => provider === value);
}

export async function createBotWorkspace(
  input: CreateBotWorkspaceInput,
): Promise<AkeruBotWorkspace | undefined> {
  if (isRemoteBotSandbox(input.sandbox)) {
    const remote = await (input.makeRemoteWorkspace ?? createRemoteBotWorkspace)({
      threadId: input.threadId,
      sandbox: input.sandbox,
      ...(input.identityFile ? { identityFile: input.identityFile } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    });
    return remote instanceof Workspace ? wrap(remote, input.sandbox) : remote;
  }
  const root = input.localRoot ?? input.cwd;
  if (!root) return undefined;
  await NodeFS.promises.mkdir(root, { recursive: true, mode: 0o700 });
  const workspace = new Workspace({
    id: input.workspaceId ?? `akeru-${input.threadId}`,
    name: `Akeru ${input.threadId}`,
    filesystem: new LocalFilesystem({ basePath: root }),
    sandbox: new LocalSandbox({ workingDirectory: root }),
    tools: TOOL_NAME_OVERRIDES,
  });
  return wrap(workspace, "local");
}

export async function createRemoteBotWorkspace(
  input: CreateRemoteBotWorkspaceInput,
): Promise<AkeruBotWorkspace> {
  if (!input.identityFile || !input.workspaceId)
    throw new Error(`Remote sandbox '${input.sandbox}' needs a stable workspace identity.`);
  const identityFile = input.identityFile;
  const persisted = await readIdentity(identityFile);
  if (persisted && persisted.provider !== input.sandbox)
    throw new Error(
      `Workspace '${input.workspaceId}' belongs to '${persisted.provider}', not '${input.sandbox}'.`,
    );
  let session: AkeruRemoteSession;
  try {
    session = input.openSession
      ? await input.openSession(persisted?.providerId)
      : persisted
        ? await open(input.sandbox, persisted.providerId)
        : await create(input.sandbox, input.workspaceId);
  } catch (cause) {
    if (!persisted) throw cause;
    throw new Error(
      `Remote ${input.sandbox} workspace '${persisted.providerId}' is missing or unavailable. Remove '${identityFile}' to create a replacement.`,
      { cause },
    );
  }
  if (!persisted) {
    try {
      await writeIdentity(identityFile, {
        provider: input.sandbox,
        providerId: session.providerId,
      });
    } catch (cause) {
      await session.destroy().catch(() => undefined);
      throw cause;
    }
  }
  const workspace = new Workspace({
    id: input.workspaceId,
    name: `Akeru ${input.workspaceId}`,
    filesystem: new BotWorkspaceFilesystem(input.workspaceId, input.sandbox, session),
    sandbox: new RemoteSandbox(input.workspaceId, input.sandbox, session),
    tools: TOOL_NAME_OVERRIDES,
  });
  return {
    id: input.workspaceId,
    provider: input.sandbox,
    providerId: session.providerId,
    workspace,
    inspect: session.inspect,
    wake: () => workspace.init(),
    sleep: () => workspace.stop(),
    destroy: async () => {
      await workspace.destroy();
      await NodeFS.promises.rm(identityFile, { force: true });
    },
  };
}

function wrap(workspace: Workspace, provider: "local" | RemoteBotSandbox): AkeruBotWorkspace {
  return {
    id: workspace.id,
    provider,
    workspace,
    inspect: async () =>
      workspace.status === "destroyed"
        ? "missing"
        : workspace.status === "paused"
          ? "sleeping"
          : "running",
    wake: () => workspace.init(),
    sleep: () => workspace.stop(),
    destroy: () => workspace.destroy(),
  };
}

class RemoteSandbox extends MastraSandbox {
  readonly name: string;
  readonly provider: string;
  readonly id: string;
  private readonly session: AkeruRemoteSession;
  status: ProviderStatus = "pending";
  constructor(id: string, provider: RemoteBotSandbox, session: AkeruRemoteSession) {
    super({ name: `Akeru ${provider}` });
    this.id = id;
    this.name = `Akeru ${provider}`;
    this.provider = provider;
    this.session = session;
  }
  override async start() {
    await this.session.wake();
    return { outcome: "connected" as const };
  }
  override stop() {
    return this.session.sleep();
  }
  override destroy() {
    return this.session.destroy();
  }
  override async executeCommand(
    command: string,
    args: string[] = [],
    options?: ExecuteCommandOptions,
  ): Promise<CommandResult> {
    const startedAt = performance.now();
    const env = options?.env
      ? Object.fromEntries(
          Object.entries(options.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        )
      : undefined;
    const result = await this.session.run(command, args, {
      ...(options?.cwd ? { cwd: options.cwd } : {}),
      ...(env ? { env } : {}),
      ...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
    });
    return {
      ...result,
      success: result.exitCode === 0,
      executionTimeMs: performance.now() - startedAt,
    };
  }
}

async function readIdentity(path: string) {
  try {
    const value = JSON.parse(await NodeFS.promises.readFile(path, "utf8")) as {
      provider?: unknown;
      providerId?: unknown;
    };
    if (
      !REMOTE_BOT_SANDBOXES.includes(value.provider as RemoteBotSandbox) ||
      typeof value.providerId !== "string" ||
      !value.providerId
    )
      throw new Error(`Workspace identity file '${path}' is invalid.`);
    return { provider: value.provider as RemoteBotSandbox, providerId: value.providerId };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

async function writeIdentity(
  path: string,
  identity: { provider: RemoteBotSandbox; providerId: string },
) {
  await NodeFS.promises.mkdir(NodePath.dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await NodeFS.promises.writeFile(temporary, `${JSON.stringify(identity)}\n`, { mode: 0o600 });
  await NodeFS.promises.rename(temporary, path);
}

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const commandLine = (command: string, args: readonly string[]) =>
  [command, ...args].map(quote).join(" ");

async function create(provider: RemoteBotSandbox, id: string): Promise<AkeruRemoteSession> {
  if (provider === "e2b") {
    const { Sandbox } = await import("e2b");
    return e2b(await Sandbox.create({ lifecycle: { onTimeout: "pause" } }));
  }
  if (provider === "daytona") {
    const { Daytona } = await import("@daytona/sdk");
    const client = new Daytona();
    return daytona(client, await client.create({ name: id }));
  }
  if (provider === "vercel") {
    const { Sandbox } = await import("@vercel/sandbox");
    return vercel(await Sandbox.create({ name: id, persistent: true }));
  }
  const { Box } = await import("@upstash/box");
  return upstash(await Box.create());
}

async function open(provider: RemoteBotSandbox, id: string): Promise<AkeruRemoteSession> {
  if (provider === "e2b") {
    const { Sandbox } = await import("e2b");
    return e2b(await Sandbox.connect(id));
  }
  if (provider === "daytona") {
    const { Daytona } = await import("@daytona/sdk");
    const client = new Daytona();
    return daytona(client, await client.get(id));
  }
  if (provider === "vercel") {
    const { Sandbox } = await import("@vercel/sandbox");
    return vercel(await Sandbox.get({ name: id, resume: true }));
  }
  const { Box } = await import("@upstash/box");
  return upstash(await Box.get(id));
}

function e2b(initial: import("e2b").Sandbox): AkeruRemoteSession {
  let sandbox = initial;
  const providerId = sandbox.sandboxId;
  return {
    providerId,
    inspect: async () => {
      const { Sandbox } = await import("e2b");
      const info = await Sandbox.getInfo(providerId);
      return info.state === "paused" ? "sleeping" : "running";
    },
    run: async (command, args, options) => {
      const result = await sandbox.commands.run(commandLine(command, args), {
        ...(options?.cwd ? { cwd: options.cwd } : {}),
        ...(options?.env ? { envs: options.env } : {}),
        ...(options?.timeout ? { timeoutMs: options.timeout } : {}),
      });
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    },
    wake: async () => {
      const { Sandbox } = await import("e2b");
      sandbox = await Sandbox.connect(providerId);
    },
    sleep: async () => {
      await sandbox.pause();
    },
    destroy: async () => {
      await sandbox.kill();
    },
  };
}

export function daytona(
  client: import("@daytona/sdk").Daytona,
  sandbox: import("@daytona/sdk").Sandbox,
): AkeruRemoteSession {
  return {
    providerId: sandbox.id,
    inspect: async () => {
      await sandbox.refreshData();
      const current = String(sandbox.state);
      return current === "destroyed" ? "missing" : current === "started" ? "running" : "sleeping";
    },
    run: async (command, args, options) => {
      const result = await sandbox.process.executeCommand(
        commandLine(command, args),
        options?.cwd,
        options?.env,
        options?.timeout ? Math.ceil(options.timeout / 1000) : undefined,
      );
      return { exitCode: result.exitCode, stdout: result.result, stderr: "" };
    },
    wake: async () => {
      if ((await sandbox.refreshData(), String(sandbox.state)) !== "started") {
        await sandbox.start();
      }
    },
    sleep: () => sandbox.pause(),
    destroy: async () => {
      await sandbox.delete(undefined, true);
      await client[Symbol.asyncDispose]();
    },
  };
}

export function vercelWorkspaceState(
  status: import("@vercel/sandbox").Sandbox["status"],
): AkeruWorkspaceState {
  if (status === "running") return "running";
  if (status === "failed" || status === "aborted") return "missing";
  return "sleeping";
}

function vercel(initial: import("@vercel/sandbox").Sandbox): AkeruRemoteSession {
  let sandbox = initial;
  return {
    providerId: sandbox.name,
    inspect: async () => {
      const { Sandbox } = await import("@vercel/sandbox");
      sandbox = await Sandbox.get({ name: sandbox.name, resume: false });
      return vercelWorkspaceState(sandbox.status);
    },
    run: async (command, args, options) => {
      const result = await sandbox.runCommand({
        cmd: command,
        args: [...args],
        ...(options?.cwd ? { cwd: options.cwd } : {}),
        ...(options?.env ? { env: options.env } : {}),
        ...(options?.timeout ? { timeoutMs: options.timeout } : {}),
      });
      return {
        exitCode: result.exitCode,
        stdout: await result.stdout(),
        stderr: await result.stderr(),
      };
    },
    wake: async () => {
      const { Sandbox } = await import("@vercel/sandbox");
      sandbox = await Sandbox.get({ name: sandbox.name, resume: true });
    },
    sleep: async () => {
      await sandbox.stop();
    },
    destroy: async () => {
      await sandbox.delete();
    },
  };
}

export function upstash(box: import("@upstash/box").Box): AkeruRemoteSession {
  const inspect = async () => {
    const status = (await box.getStatus()).status;
    return upstashWorkspaceState(status);
  };
  return {
    providerId: box.id,
    inspect,
    run: async (command, args, options) => {
      const assignments = Object.entries(options?.env ?? {}).map(
        ([key, value]) => `${key}=${value}`,
      );
      let line =
        assignments.length > 0
          ? commandLine("env", ["--", ...assignments, command, ...args])
          : commandLine(command, args);
      if (options?.timeout !== undefined) {
        line = commandLine("timeout", [`${options.timeout / 1_000}s`, "sh", "-lc", line]);
      }
      const result = await box.exec.command(
        `${options?.cwd ? `cd ${quote(options.cwd)} && ` : ""}${line}`,
      );
      return { exitCode: result.exitCode ?? 1, stdout: result.result, stderr: "" };
    },
    wake: async () => {
      const current = await inspect();
      if (current === "missing") {
        throw new Error(`Upstash workspace '${box.id}' is missing.`);
      }
      if (current === "sleeping") {
        await box.resume();
      }
    },
    sleep: () => box.pause(),
    destroy: () => box.delete(),
  };
}

export function upstashWorkspaceState(status: string): AkeruWorkspaceState {
  if (status === "running" || status === "idle") return "running";
  if (status === "error" || status === "deleted") return "missing";
  return "sleeping";
}
