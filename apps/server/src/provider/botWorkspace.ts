// @effect-diagnostics globalFetch:off nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import { TOOL_NAME_OVERRIDES } from "@mastra/code-sdk/tool-names";
import { LocalFilesystem, LocalSandbox, Workspace } from "@mastra/core/workspace";
import type { BotSandbox } from "@akeru/contracts";
import { BotWorkspaceFilesystem } from "./botWorkspaceFilesystem.ts";
import {
  type RemoteBotSandbox,
  REMOTE_BOT_SANDBOXES,
  type CreateBotWorkspaceInput,
  type AkeruBotWorkspace,
  type CreateRemoteBotWorkspaceInput,
  type AkeruRemoteSession,
} from "./workspace/BotWorkspaceTypes.ts";
import {
  wrap,
  readIdentity,
  writeIdentity,
  credential,
} from "./workspace/BotWorkspaceLifecycle.ts";
import { RemoteSandbox } from "./workspace/RemoteSandbox.ts";
import { ascii } from "./workspace/adapters/Ascii.ts";
import { e2b } from "./workspace/adapters/E2b.ts";
import { daytona } from "./workspace/adapters/Daytona.ts";
import { vercel } from "./workspace/adapters/Vercel.ts";
import { railway, railwayCredentials } from "./workspace/adapters/Railway.ts";
import { tenki } from "./workspace/adapters/Tenki.ts";
import { upstash } from "./workspace/adapters/Upstash.ts";

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
      ...(input.environment ? { environment: input.environment } : {}),
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
        ? await open(input.sandbox, persisted.providerId, input.environment)
        : await create(input.sandbox, input.workspaceId, input.environment);
  } catch (cause) {
    if (!persisted) throw cause;
    throw new Error(
      `Remote ${input.sandbox} workspace '${persisted.providerId}' is missing or unavailable. Remove '${identityFile}' to create a replacement.`,
      { cause },
    );
  }
  if (!persisted || persisted.providerId !== session.providerId) {
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
    ...(session.computer ? { computer: session.computer } : {}),
    workspace,
    browserEndpoint: session.browserEndpoint,
    inspect: session.inspect,
    wake: () => workspace.init(),
    sleep: async () => {
      await session.computer?.close();
      await workspace.stop();
    },
    destroy: async () => {
      await session.computer?.close();
      await workspace.destroy();
      await NodeFS.promises.rm(identityFile, { force: true });
    },
  };
}

async function create(
  provider: RemoteBotSandbox,
  id: string,
  environment: Readonly<Record<string, string>> = {},
): Promise<AkeruRemoteSession> {
  if (provider === "ascii") {
    const { BoxApi, Configuration } = await import("@asciidev/box-sdk");
    const client = new BoxApi(
      new Configuration({ accessToken: credential(environment, "BOX_API_KEY") }),
    );
    const { box } = await client.create({ createBoxRequest: { ttlSeconds: null, noEnv: true } });
    return ascii(client, box.id);
  }
  if (provider === "e2b") {
    const { Sandbox } = await import("e2b");
    const apiKey = credential(environment, "E2B_API_KEY");
    return e2b(
      await Sandbox.create({
        apiKey,
        lifecycle: { onTimeout: "pause" },
        network: { allowPublicTraffic: false },
      }),
      apiKey,
    );
  }
  if (provider === "daytona") {
    const { Daytona } = await import("@daytona/sdk");
    const client = new Daytona({ apiKey: credential(environment, "DAYTONA_API_KEY") });
    return daytona(client, await client.create({ name: id }));
  }
  if (provider === "vercel") {
    const { Sandbox } = await import("@vercel/sandbox");
    return vercel(
      await Sandbox.create({
        name: id,
        persistent: true,
        token: credential(environment, "VERCEL_TOKEN"),
        teamId: credential(environment, "VERCEL_TEAM_ID"),
        projectId: credential(environment, "VERCEL_PROJECT_ID"),
      }),
      environment,
    );
  }
  if (provider === "railway") {
    const { Sandbox } = await import("railway");
    return railway(await Sandbox.create(railwayCredentials(environment)));
  }
  if (provider === "tenki") {
    const { TenkiSandbox } = await import("@tenkicloud/sandbox");
    const client = new TenkiSandbox({ apiKey: credential(environment, "TENKI_API_KEY") });
    // Persist the VM identity before wake waits for readiness, which can fail transiently.
    return tenki(await client.create({ name: id, sticky: true, waitReady: false }));
  }
  const { Box } = await import("@upstash/box");
  return upstash(await Box.create({ apiKey: credential(environment, "UPSTASH_BOX_API_KEY") }));
}

async function open(
  provider: RemoteBotSandbox,
  id: string,
  environment: Readonly<Record<string, string>> = {},
): Promise<AkeruRemoteSession> {
  if (provider === "ascii") {
    const { BoxApi, Configuration, ResponseError } = await import("@asciidev/box-sdk");
    const client = new BoxApi(
      new Configuration({ accessToken: credential(environment, "BOX_API_KEY") }),
    );
    try {
      await client.get({ boxId: id });
    } catch (cause) {
      if (!(cause instanceof ResponseError) || cause.response.status !== 404) throw cause;
      // A timed-out deletion can finish later; only confirmed absence permits replacement.
      const { box } = await client.create({ createBoxRequest: { ttlSeconds: null, noEnv: true } });
      return ascii(client, box.id);
    }
    return ascii(client, id);
  }
  if (provider === "e2b") {
    const { Sandbox } = await import("e2b");
    const apiKey = credential(environment, "E2B_API_KEY");
    return e2b(await Sandbox.connect(id, { apiKey }), apiKey);
  }
  if (provider === "daytona") {
    const { Daytona } = await import("@daytona/sdk");
    const client = new Daytona({ apiKey: credential(environment, "DAYTONA_API_KEY") });
    return daytona(client, await client.get(id));
  }
  if (provider === "vercel") {
    const { Sandbox } = await import("@vercel/sandbox");
    return vercel(
      await Sandbox.get({
        name: id,
        resume: true,
        token: credential(environment, "VERCEL_TOKEN"),
        teamId: credential(environment, "VERCEL_TEAM_ID"),
        projectId: credential(environment, "VERCEL_PROJECT_ID"),
      }),
      environment,
    );
  }
  if (provider === "railway") {
    const { Sandbox } = await import("railway");
    const session = railway(await Sandbox.connect(id, railwayCredentials(environment)));
    await session.wake();
    return session;
  }
  if (provider === "tenki") {
    const { TenkiSandbox } = await import("@tenkicloud/sandbox");
    const client = new TenkiSandbox({ apiKey: credential(environment, "TENKI_API_KEY") });
    return tenki(await client.get(id));
  }
  const { Box } = await import("@upstash/box");
  return upstash(await Box.get(id, { apiKey: credential(environment, "UPSTASH_BOX_API_KEY") }));
}

export {
  REMOTE_BOT_SANDBOXES,
  type RemoteBotSandbox,
  type AkeruWorkspaceState,
  type AkeruBrowserEndpoint,
  type AkeruBotWorkspace,
  type AkeruRemoteSession,
  type CreateRemoteBotWorkspaceInput,
  type CreateBotWorkspaceInput,
} from "./workspace/BotWorkspaceTypes.ts";

export { railway, railwayWorkspaceState } from "./workspace/adapters/Railway.ts";

export { ascii } from "./workspace/adapters/Ascii.ts";

export { tenki, tenkiWorkspaceState } from "./workspace/adapters/Tenki.ts";

export { e2b } from "./workspace/adapters/E2b.ts";

export { daytona } from "./workspace/adapters/Daytona.ts";

export { vercelWorkspaceState, vercel } from "./workspace/adapters/Vercel.ts";

export { upstash, upstashWorkspaceState } from "./workspace/adapters/Upstash.ts";
