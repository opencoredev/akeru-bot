import * as Effect from "effect/Effect";
import { TOOL_NAME_OVERRIDES } from "@mastra/code-sdk/tool-names";
import { LocalFilesystem, LocalSandbox, Workspace } from "@mastra/core/workspace";
import type { BotSandbox } from "@akeru/contracts";
import {
  connectSandbox,
  createSandbox,
  SandboxError,
  type SandboxBase,
} from "@opencoredev/sandbox-sdk";
import type { Provider, SandboxInfo } from "@opencoredev/sandbox-sdk/provider";
import type { BotWorkspaceIO } from "./workspace/BotWorkspaceIO.ts";
import { BotWorkspaceFilesystem, SANDBOX_WORKDIR } from "./botWorkspaceFilesystem.ts";
import {
  type RemoteBotSandbox,
  REMOTE_BOT_SANDBOXES,
  type CreateBotWorkspaceInput,
  type AkeruBotWorkspace,
  type CreateRemoteBotWorkspaceInput,
  type AkeruRemoteSession,
  type BotWorkspaceReattach,
} from "./workspace/BotWorkspaceTypes.ts";
import {
  commandLine,
  wrap,
  readIdentity,
  writeIdentity,
  type WorkspaceIdentity,
} from "./workspace/BotWorkspaceLifecycle.ts";
import { RemoteSandbox } from "./workspace/RemoteSandbox.ts";
import { sandboxBinding, type SandboxBinding } from "./workspace/SandboxProviders.ts";
import { withAdoption, type AdoptionEffects } from "./workspace/SandboxAdoption.ts";
import { sandboxSession, wakeSandbox } from "./workspace/SandboxSession.ts";

export function isRemoteBotSandbox(
  value: BotSandbox | null | undefined,
): value is RemoteBotSandbox {
  return REMOTE_BOT_SANDBOXES.some((provider) => provider === value);
}

export async function createBotWorkspace(
  input: CreateBotWorkspaceInput,
): Promise<AkeruBotWorkspace | undefined> {
  if (isRemoteBotSandbox(input.sandbox)) {
    if (
      input.reattach &&
      !(await savedSandboxMatches(input.io, input.identityFile, input.reattach))
    )
      return undefined;

    const remote = await (input.makeRemoteWorkspace ?? createRemoteBotWorkspace)({
      io: input.io,
      threadId: input.threadId,
      sandbox: input.sandbox,
      ...(input.identityFile ? { identityFile: input.identityFile } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.environment ? { environment: input.environment } : {}),
      ...(input.reattach ? { reattach: input.reattach } : {}),
    });

    return remote instanceof Workspace ? wrap(remote, input.sandbox) : remote;
  }

  const root = input.localRoot ?? input.cwd;

  if (!root) return undefined;
  await input.io.mkdir(root);

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
  let persisted = await readIdentity(input.io, identityFile);

  if (persisted && persisted.provider !== input.sandbox)
    throw new Error(
      `Workspace '${input.workspaceId}' belongs to '${persisted.provider}', not '${input.sandbox}'.`,
    );

  if (input.reattach && !matchesSaved(persisted, input.reattach))
    throw new Error(
      `Remote ${input.sandbox} workspace '${input.workspaceId}' has no saved sandbox to reattach; cleanup never creates one.`,
    );

  // A sandbox left by a failed setup is deleted, and its ID dropped, before a new one is made.
  if (persisted?.cleanup && !input.openSession) {
    await removeAbandoned(await binding(input), input.io, identityFile, persisted);
    persisted = undefined;
  }

  let session: AkeruRemoteSession;

  try {
    session = input.openSession
      ? await input.openSession(persisted?.providerId)
      : persisted
        ? await reattach(await binding(input), input.io, identityFile, persisted)
        : await create(await binding(input), input.io, identityFile, input.sandbox);
  } catch (cause) {
    if (!persisted) throw cause;
    throw new Error(
      `Remote ${input.sandbox} workspace '${persisted.providerId}' is missing or unavailable. Remove '${identityFile}' to create a replacement.`,
      { cause },
    );
  }

  // `create` persists the ID itself; injected sessions are recorded here.
  if (input.openSession && (!persisted || persisted.providerId !== session.providerId)) {
    try {
      await writeIdentity(input.io, identityFile, {
        provider: input.sandbox,
        providerId: session.providerId,
      });
    } catch (cause) {
      await session.destroy().catch(() => undefined);
      throw cause;
    }
  }

  // Mastra skips a sandbox's `destroy` while it was never started, so the provider is
  // deleted here directly. Concurrent and repeated calls share one deletion; a failed one can retry.
  let deletion: Promise<void> | undefined;

  const deleteSandbox = () =>
    (deletion ??= session.destroy().catch((cause: unknown) => {
      deletion = undefined;
      throw cause;
    }));

  const remote = { ...session, destroy: deleteSandbox };

  const workspace = new Workspace({
    id: input.workspaceId,
    name: `Akeru ${input.workspaceId}`,
    filesystem: new BotWorkspaceFilesystem(input.workspaceId, input.sandbox, remote),
    sandbox: new RemoteSandbox(input.workspaceId, input.sandbox, remote),
    tools: TOOL_NAME_OVERRIDES,
  });

  return {
    id: input.workspaceId,
    provider: input.sandbox,
    providerId: session.providerId,
    created: persisted === undefined,
    ...(session.capabilities ? { capabilities: session.capabilities } : {}),
    ...(session.computer ? { computer: session.computer } : {}),
    workspace,
    browserEndpoint: session.browserEndpoint,
    inspect: session.inspect,
    wake: () => workspace.init(),
    sleep: async () => {
      await session.computer?.close();
      await workspace.stop();
    },
    // The identity file goes only after the provider confirms deletion, so a failed
    // destroy keeps the sandbox ID for the next cleanup attempt. A stale handle leaves a
    // file that now names a replacement sandbox.
    destroy: async () => {
      await session.computer?.close();
      await deleteSandbox();
      await workspace.destroy();

      if ((await readIdentity(input.io, identityFile))?.providerId === session.providerId)
        await input.io.remove(identityFile);
    },
  };
}

/** Cleanup reattaches only to a live saved sandbox, and to the one it lost when it knows it. */
function matchesSaved(
  persisted: WorkspaceIdentity | undefined,
  reattach: BotWorkspaceReattach,
): boolean {
  return (
    persisted !== undefined &&
    !persisted.cleanup &&
    (reattach.providerId === undefined || persisted.providerId === reattach.providerId)
  );
}

async function savedSandboxMatches(
  io: BotWorkspaceIO,
  identityFile: string | undefined,
  reattach: BotWorkspaceReattach,
): Promise<boolean> {
  return identityFile !== undefined && matchesSaved(await readIdentity(io, identityFile), reattach);
}

function binding(input: CreateRemoteBotWorkspaceInput): Promise<SandboxBinding> {
  return input.sandboxBinding
    ? Promise.resolve(input.sandboxBinding)
    : sandboxBinding(input.sandbox, input.environment);
}

async function reattach(
  binding: SandboxBinding,
  io: BotWorkspaceIO,
  identityFile: string,
  identity: WorkspaceIdentity,
): Promise<AkeruRemoteSession> {
  try {
    return await reattachWith(binding, io, identityFile, identity);
  } catch (cause) {
    // The SDK refuses a session it cannot recognize (legacy Tenki); the binding's shim
    // reattaches it instead, and reports `not_found` itself if the session is really gone.
    if (!binding.legacy || !(cause instanceof SandboxError && cause.code === "not_found"))
      throw cause;

    return reattachWith(await binding.legacy(), io, identityFile, identity);
  }
}

async function reattachWith(
  binding: SandboxBinding,
  io: BotWorkspaceIO,
  identityFile: string,
  identity: WorkspaceIdentity,
): Promise<AkeruRemoteSession> {
  // Where `connect` itself wakes a paused sandbox (E2B resumes; Upstash runs a command), the
  // state is read first and the re-pause armed before connecting: connect can resume the
  // sandbox and then fail, and any failure from here on must put it back to sleep.
  const before = await binding.peek?.(identity.providerId);
  const effects: AdoptionEffects = { resumed: before === "paused" || before === "stopped" };

  try {
    // Akeru passes no SDK secrets, so reattaching runs no recovery command on the sandbox.
    const box = await withAdoption(
      binding.adopt,
      identity.providerId,
      () => connectSandbox(binding.provider, identity.providerId, { recoverSecrets: false }),
      effects,
    );

    if (identity.workdir !== undefined)
      return await sandboxSession(box, binding, identity.workdir, identity.user);

    // An old adapter made this sandbox and its files live in the provider's own default
    // directory. Finding it runs a guest command, so the sandbox is woken first (an archived
    // Ascii box, a stopped Daytona sandbox). The identity changes only once all of it worked.
    await wakeSandbox(box, binding, effects);
    const user = binding.legacyUser;
    const workdir = await legacyWorkdir(binding, box);
    await writeIdentity(io, identityFile, { ...identity, workdir, ...(user ? { user } : {}) });

    return await sandboxSession(box, binding, workdir, user);
  } catch (cause) {
    // No lease will put a sandbox this reattach woke back to sleep, so it is paused here.
    if (effects.resumed) await pauseAgain(binding, identity.providerId);
    throw cause;
  }
}

/** Best effort: the reattach error is the one to report, so a failed pause is only logged. */
async function pauseAgain(binding: SandboxBinding, id: string) {
  try {
    await binding.provider.pause?.(id);
  } catch (cause) {
    await Effect.runPromise(
      Effect.logWarning("Could not pause a sandbox that a failed reattach woke", {
        provider: binding.provider.name,
        sandboxId: id,
        cause,
      }),
    );
  }
}

/** Prints the home directory of user `$1`, with or without `getent` on the image. */
const PASSWD_HOME =
  '{ getent passwd "$1" 2>/dev/null || grep "^$1:" /etc/passwd; } | head -n 1 | cut -d: -f6';

/**
 * The binding's native probe; else the home of the old adapter's user from the passwd
 * database (E2B: `user`, while the SDK runs as root); else `$HOME`.
 */
async function legacyWorkdir(binding: SandboxBinding, box: SandboxBase<unknown>): Promise<string> {
  const user = binding.legacyUser;

  const reported = binding.legacyWorkdir
    ? await binding.legacyWorkdir(box.id)
    : user
      ? (await box.run(commandLine("sh", ["-c", PASSWD_HOME, "sh", user]), { cwd: "/" })).stdout
      : (await box.run('printf %s "$HOME"', { cwd: "/" })).stdout;

  const workdir = reported.trim();

  if (!workdir.startsWith("/") || workdir.includes("\n"))
    throw new Error(`Could not find the working directory of ${box.provider} sandbox '${box.id}'.`);

  return workdir;
}

/**
 * Creates a sandbox and records its ID before anything else can fail. sandbox-sdk
 * drops the ID when handle setup and its own cleanup both fail (opencoredev/sandbox-sdk#35),
 * so the ID is written from inside the provider's `create`, before the SDK builds the handle.
 */
async function create(
  binding: SandboxBinding,
  io: BotWorkspaceIO,
  identityFile: string,
  sandbox: RemoteBotSandbox,
): Promise<AkeruRemoteSession> {
  const native = binding.provider;
  let allocated: string | undefined;

  const recording: Provider = {
    ...native,
    create: async (request) => {
      let info: SandboxInfo;

      try {
        info = await native.create(request);
      } catch (cause) {
        // A provider that allocated a sandbox and then failed to set it up and to delete it
        // names it on the error. Keep that ID, marked for deletion, until deletion succeeds.
        if (cause instanceof SandboxError && cause.sandboxId) {
          const id = cause.sandboxId;
          allocated = id;

          try {
            await writeIdentity(io, identityFile, {
              provider: sandbox,
              providerId: id,
              workdir: SANDBOX_WORKDIR,
              cleanup: true,
            });
          } catch (recording) {
            throw new Error(
              `${sandbox} sandbox '${id}' failed during setup and could not be recorded. Delete it in the provider if it still exists.`,
              { cause: recording },
            );
          }
        }

        throw cause;
      }

      try {
        await writeIdentity(io, identityFile, {
          provider: sandbox,
          providerId: info.id,
          workdir: SANDBOX_WORKDIR,
        });
      } catch (cause) {
        await native.destroy(info.id).catch(() => undefined);
        throw new Error(
          `Could not record ${sandbox} sandbox '${info.id}'. Delete it in the provider if it still exists.`,
          { cause },
        );
      }

      allocated = info.id;

      return info;
    },
  };

  try {
    const box = await createSandbox(recording, binding.ports ? { ports: [...binding.ports] } : {});

    return await sandboxSession(box, binding, SANDBOX_WORKDIR);
  } catch (cause) {
    if (allocated !== undefined && (await confirmedGone(binding, allocated)))
      await io.remove(identityFile);
    throw cause;
  }
}

async function removeAbandoned(
  binding: SandboxBinding,
  io: BotWorkspaceIO,
  identityFile: string,
  identity: WorkspaceIdentity,
) {
  try {
    await binding.provider.destroy(identity.providerId);
  } catch (cause) {
    if (!(cause instanceof SandboxError && cause.code === "not_found"))
      throw new Error(
        `Could not delete ${identity.provider} sandbox '${identity.providerId}' left by a failed setup. Delete it in the provider, then remove '${identityFile}'.`,
        { cause },
      );
  }

  await io.remove(identityFile);
}

/**
 * Only a provider's `not_found` proves a sandbox is gone; any other answer keeps its ID.
 * Missing SDK metadata is not absence: adoption asks the provider's own SDK first.
 */
async function confirmedGone(binding: SandboxBinding, id: string): Promise<boolean> {
  try {
    await withAdoption(binding.adopt, id, () => binding.provider.connect(id));

    return false;
  } catch (cause) {
    return cause instanceof SandboxError && cause.code === "not_found";
  }
}

export {
  REMOTE_BOT_SANDBOXES,
  type RemoteBotSandbox,
  type AkeruWorkspaceState,
  type AkeruWorkspaceCapabilities,
  type AkeruBrowserEndpoint,
  type AkeruBotWorkspace,
  type AkeruRemoteSession,
  type AkeruSandboxFiles,
  type CreateRemoteBotWorkspaceInput,
  type CreateBotWorkspaceInput,
} from "./workspace/BotWorkspaceTypes.ts";
