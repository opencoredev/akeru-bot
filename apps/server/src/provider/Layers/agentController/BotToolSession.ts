import type { AkeruDelegationAccessGrant, AkeruDelegationRecord, BotId } from "@akeru/contracts";
import type { OrchestrationBot, ThreadId } from "@akeru/contracts";

import type { AkeruToolSession } from "../../AkeruToolRuntime.ts";
import type { AgentControllerShape } from "../../Services/AgentController.ts";
import { createSessionCatalogHandlers } from "./CatalogToolHandlers.ts";
import type { SessionLifecycleDependencies } from "./SessionLifecycleDependencies.ts";
import { toolPermissionsFor } from "./ToolPermissions.ts";

/** Tool-session fields the workspace owns. A shared session keeps them when another bot answers. */
export type WorkspaceToolSession = Pick<
  AkeruToolSession,
  "workspaceType" | "workspace" | "userComputerWorkspace" | "timezone"
>;

/**
 * Every other field acts as, bills, or checks the answering bot, so each start rebuilds it.
 * A new tool-session field lands here by default, which keeps a handoff from inheriting it.
 */
export type BotScopedToolSession = Omit<AkeruToolSession, keyof WorkspaceToolSession>;

export function workspaceToolSession(session: AkeruToolSession): WorkspaceToolSession {
  return {
    workspaceType: session.workspaceType,
    ...(session.workspace ? { workspace: session.workspace } : {}),
    ...(session.userComputerWorkspace
      ? { userComputerWorkspace: session.userComputerWorkspace }
      : {}),
    ...(session.timezone !== undefined ? { timezone: session.timezone } : {}),
  };
}

/** Builds the tools that speak for one bot: its identity, policy, memory, messaging and channels. */
export function botScopedToolSession(
  deps: SessionLifecycleDependencies,
  input: {
    readonly threadId: ThreadId;
    readonly startInput: Parameters<AgentControllerShape["startSession"]>[1];
    readonly bot: OrchestrationBot | undefined;
    readonly botId: BotId | null;
    readonly parentDelegation: AkeruDelegationRecord | undefined;
    readonly access: AkeruDelegationAccessGrant;
    readonly delegated: boolean;
    readonly activeChildDelegations: number;
    readonly isWorkerThread: boolean;
    readonly workerParentAccess: AkeruDelegationAccessGrant;
    readonly memoryHandlers: AkeruToolSession["memoryHandlers"];
    readonly imageGeneration: NonNullable<AkeruToolSession["imageGeneration"]>;
  },
): BotScopedToolSession {
  const { threadId, startInput, bot, botId, parentDelegation, access } = input;
  const key = String(threadId);
  const wired = deps.wired();
  const inputBotId = startInput.botId;
  // Late wiring can replace a runtime after the session starts, so calls read the current one.
  const delegationRuntime = wired.delegationRuntime;
  const channelRuntime = wired.channelRuntime;

  return {
    ...(botId ? { botId } : {}),
    ...(startInput.botName ? { botName: startInput.botName } : {}),
    runtimeMode: access.runtimeMode,
    permissions: toolPermissionsFor(deps, {
      bot,
      botId,
      parentBotId: parentDelegation?.parentBotId,
    }),
    ...(input.memoryHandlers ? { memoryHandlers: input.memoryHandlers } : {}),
    ...(inputBotId && wired.botStateRuntime ? { botState: wired.botStateRuntime } : {}),
    imageGeneration: input.imageGeneration,
    catalogHandlers: createSessionCatalogHandlers(deps, {
      threadId,
      botId: inputBotId,
      botName: startInput.botName,
      mcpManager: deps.sessionResources.getMcpManager(key),
    }),
    ...(input.delegated && botId ? { billedBotId: botId } : {}),
    ...(delegationRuntime && botId
      ? {
          sendToUser: async (request) => {
            const turnId = deps.sessions.get(key)?.activeTurn?.turnId;

            if (!turnId) throw new Error("User messaging requires an active turn.");

            return (deps.wired().delegationRuntime ?? delegationRuntime).sendToUser(
              {
                threadId,
                turnId,
                botId,
                parentDelegationId: parentDelegation?.delegationId ?? null,
                ancestorBotIds: parentDelegation?.ancestorBotIds ?? [],
                depth: parentDelegation?.depth ?? 0,
                access,
              },
              request,
            );
          },
          delegation: deps.delegationFor({
            threadId,
            botId,
            parentDelegation,
            access,
            activeChildDelegations: input.activeChildDelegations,
          }),
        }
      : {}),
    ...(wired.workerOrchestration && botId && !input.isWorkerThread
      ? { workers: deps.workersFor(threadId, input.workerParentAccess) }
      : {}),
    ...(inputBotId && channelRuntime
      ? {
          reactToMessage: (request, toolCallId) =>
            (deps.wired().channelRuntime ?? channelRuntime).react(
              threadId,
              inputBotId,
              request,
              toolCallId,
            ),
          channels: {
            create: (request) =>
              (deps.wired().channelRuntime ?? channelRuntime).create(inputBotId, request),
            update: (request) =>
              (deps.wired().channelRuntime ?? channelRuntime).update(inputBotId, request),
          },
        }
      : {}),
  };
}
