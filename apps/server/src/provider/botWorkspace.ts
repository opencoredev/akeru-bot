// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import { TOOL_NAME_OVERRIDES } from "@mastra/code-sdk/tool-names";
import { LocalFilesystem, LocalSandbox, Workspace } from "@mastra/core/workspace";
import type { BotSandbox } from "@t3tools/contracts";

export const REMOTE_BOT_SANDBOXES = ["vercel", "akeru-cloud", "upstash"] as const;
export type RemoteBotSandbox = (typeof REMOTE_BOT_SANDBOXES)[number];

export function isRemoteBotSandbox(
  value: BotSandbox | null | undefined,
): value is RemoteBotSandbox {
  return REMOTE_BOT_SANDBOXES.some((sandbox) => sandbox === value);
}

export interface CreateRemoteBotWorkspaceInput {
  readonly threadId: string;
  readonly sandbox: RemoteBotSandbox;
  readonly cwd?: string;
  readonly workspaceId?: string;
}

export interface CreateBotWorkspaceInput {
  readonly threadId: string;
  readonly cwd?: string;
  readonly localRoot?: string;
  readonly sandbox?: BotSandbox | null;
  readonly workspaceId?: string;
  readonly makeRemoteWorkspace?: (input: CreateRemoteBotWorkspaceInput) => Promise<Workspace>;
}

export async function createBotWorkspace(
  input: CreateBotWorkspaceInput,
): Promise<Workspace | undefined> {
  if (isRemoteBotSandbox(input.sandbox)) {
    return await (input.makeRemoteWorkspace ?? createRemoteMastraWorkspace)({
      threadId: input.threadId,
      sandbox: input.sandbox,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    });
  }
  const localRoot = input.localRoot ?? input.cwd;
  if (!localRoot) return undefined;
  await NodeFS.promises.mkdir(localRoot, { recursive: true, mode: 0o700 });
  return new Workspace({
    id: input.workspaceId ?? `akeru-${input.threadId}`,
    name: `Akeru ${input.threadId}`,
    filesystem: new LocalFilesystem({ basePath: localRoot }),
    sandbox: new LocalSandbox({ workingDirectory: localRoot }),
    tools: TOOL_NAME_OVERRIDES,
  });
}

export async function createRemoteMastraWorkspace(
  input: CreateRemoteBotWorkspaceInput,
): Promise<Workspace> {
  throw new Error(
    `Remote sandbox '${input.sandbox}' is unavailable until its Akeru-native adapter is installed.`,
  );
}
