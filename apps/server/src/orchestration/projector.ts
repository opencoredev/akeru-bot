import type {
  BotId,
  OrchestrationBot,
  OrchestrationEvent,
  OrchestrationGroup,
  OrchestrationReadModel,
  ThreadId,
} from "@t3tools/contracts";
import {
  DelegationCreatedPayload,
  DelegationUpdatedPayload,
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationSession,
  OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { toProjectorDecodeError, type OrchestrationProjectorDecodeError } from "./Errors.ts";
import {
  BotArchivedPayload,
  BotCreatedPayload,
  BotRestoredPayload,
  BotUpdatedPayload,
  GroupBossSetPayload,
  GroupCreatedPayload,
  GroupDeletedPayload,
  GroupMemberAssignedPayload,
  GroupMemberUnassignedPayload,
  GroupPersonAssignedPayload,
  GroupPersonUnassignedPayload,
  GroupRenamedPayload,
  McpServerCreatedPayload,
  McpServerDeletedPayload,
  MessageSentPayloadSchema,
  ProjectCreatedPayload,
  ProjectDeletedPayload,
  ProjectMetaUpdatedPayload,
  ThreadActivityAppendedPayload,
  ThreadArchivedPayload,
  ThreadCreatedPayload,
  ThreadOwnershipUpdatedPayload,
  ThreadDeletedPayload,
  ThreadInteractionModeSetPayload,
  ThreadMessageReactionSetPayload,
  ThreadMetaUpdatedPayload,
  ThreadProposedPlanUpsertedPayload,
  ThreadRuntimeModeSetPayload,
  ThreadSettledPayload,
  ThreadPinnedPayload,
  ThreadPinReorderedPayload,
  ThreadSnoozedPayload,
  ThreadUnpinnedPayload,
  ThreadUnarchivedPayload,
  ThreadUnsettledPayload,
  ThreadUnsnoozedPayload,
  ThreadRevertedPayload,
  ThreadSessionSetPayload,
  ThreadTurnDiffCompletedPayload,
  ThreadTurnStartRequestedPayload,
} from "./Schemas.ts";

type ThreadPatch = Partial<Omit<OrchestrationThread, "id" | "projectId">>;
const MAX_THREAD_MESSAGES = 2_000;
const MAX_THREAD_CHECKPOINTS = 500;

function checkpointStatusToLatestTurnState(status: "ready" | "missing" | "error") {
  if (status === "error") return "error" as const;
  if (status === "missing") return "interrupted" as const;
  return "completed" as const;
}

/**
 * Turn state to settle a still-running latest turn with when its session
 * leaves the "running" status, or null while the session is (re)starting or
 * running and the turn must stay unsettled.
 */
function settledTurnStateForSessionStatus(
  status: OrchestrationSession["status"],
): "completed" | "interrupted" | "error" | null {
  switch (status) {
    case "idle":
    case "ready":
      return "completed";
    case "error":
      return "error";
    case "interrupted":
    case "stopped":
      return "interrupted";
    case "starting":
    case "running":
      return null;
  }
}

function updateBot(
  bots: ReadonlyArray<OrchestrationBot>,
  botId: BotId,
  patch: Partial<Omit<OrchestrationBot, "id" | "createdAt">>,
): OrchestrationBot[] {
  return bots.map((bot) => (bot.id === botId ? { ...bot, ...patch } : bot));
}

function updateGroup(
  groups: ReadonlyArray<OrchestrationGroup>,
  groupId: OrchestrationGroup["id"],
  patch: Partial<Omit<OrchestrationGroup, "id" | "createdAt">>,
): OrchestrationGroup[] {
  return groups.map((group) => (group.id === groupId ? { ...group, ...patch } : group));
}

function updateThread(
  threads: ReadonlyArray<OrchestrationThread>,
  threadId: ThreadId,
  patch: ThreadPatch,
): OrchestrationThread[] {
  return threads.map((thread) => (thread.id === threadId ? { ...thread, ...patch } : thread));
}

function decodeForEvent<A>(
  schema: Schema.Decoder<A, never>,
  value: unknown,
  eventType: OrchestrationEvent["type"],
  field: string,
): Effect.Effect<A, OrchestrationProjectorDecodeError> {
  return Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(toProjectorDecodeError(`${eventType}:${field}`)),
  );
}

function retainThreadMessagesAfterRevert(
  messages: ReadonlyArray<OrchestrationMessage>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
): ReadonlyArray<OrchestrationMessage> {
  const retainedMessageIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.id);
      continue;
    }
    if (message.turnId !== null && retainedTurnIds.has(message.turnId)) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.id),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.id),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.id));
}

function retainThreadActivitiesAfterRevert(
  activities: ReadonlyArray<OrchestrationThread["activities"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<OrchestrationThread["activities"][number]> {
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

function retainThreadProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<OrchestrationThread["proposedPlans"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<OrchestrationThread["proposedPlans"][number]> {
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

function compareThreadActivities(
  left: OrchestrationThread["activities"][number],
  right: OrchestrationThread["activities"][number],
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

export function createEmptyReadModel(nowIso: string): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    bots: [],
    groups: [],
    delegations: [],
    mcpServers: [],
    threads: [],
    updatedAt: nowIso,
  };
}

export function projectEvent(
  model: OrchestrationReadModel,
  event: OrchestrationEvent,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  const nextBase: OrchestrationReadModel = {
    ...model,
    snapshotSequence: event.sequence,
    updatedAt: event.occurredAt,
  };

  switch (event.type) {
    case "delegation.created":
    case "delegation.updated":
      return decodeForEvent(
        event.type === "delegation.created" ? DelegationCreatedPayload : DelegationUpdatedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          delegations: nextBase.delegations.some(
            (entry) => entry.delegationId === payload.delegation.delegationId,
          )
            ? nextBase.delegations.map((entry) =>
                entry.delegationId === payload.delegation.delegationId ? payload.delegation : entry,
              )
            : [...nextBase.delegations, payload.delegation],
        })),
      );

    case "project.created":
      return decodeForEvent(ProjectCreatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existing = nextBase.projects.find((entry) => entry.id === payload.projectId);
          const nextProject = {
            id: payload.projectId,
            title: payload.title,
            workspaceRoot: payload.workspaceRoot,
            defaultModelSelection: payload.defaultModelSelection,
            defaultThreadEnvMode: null,
            faviconPath: payload.faviconPath ?? null,
            scripts: payload.scripts,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            deletedAt: null,
          };

          return {
            ...nextBase,
            projects: existing
              ? nextBase.projects.map((entry) =>
                  entry.id === payload.projectId ? nextProject : entry,
                )
              : [...nextBase.projects, nextProject],
          };
        }),
      );

    case "project.meta-updated":
      return decodeForEvent(ProjectMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id === payload.projectId
              ? {
                  ...project,
                  ...(payload.title !== undefined ? { title: payload.title } : {}),
                  ...(payload.workspaceRoot !== undefined
                    ? { workspaceRoot: payload.workspaceRoot }
                    : {}),
                  ...(payload.defaultModelSelection !== undefined
                    ? { defaultModelSelection: payload.defaultModelSelection }
                    : {}),
                  ...(payload.defaultThreadEnvMode !== undefined
                    ? { defaultThreadEnvMode: payload.defaultThreadEnvMode }
                    : {}),
                  ...(payload.faviconPath !== undefined
                    ? { faviconPath: payload.faviconPath }
                    : {}),
                  ...(payload.scripts !== undefined ? { scripts: payload.scripts } : {}),
                  updatedAt: payload.updatedAt,
                }
              : project,
          ),
        })),
      );

    case "project.deleted":
      return decodeForEvent(ProjectDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id === payload.projectId
              ? {
                  ...project,
                  deletedAt: payload.deletedAt,
                  updatedAt: payload.deletedAt,
                }
              : project,
          ),
        })),
      );

    case "bot.created":
      return decodeForEvent(BotCreatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const bot: OrchestrationBot = {
            id: payload.botId,
            name: payload.name,
            title: payload.title,
            label: payload.label,
            description: payload.description,
            disabledMcpServerIds: payload.disabledMcpServerIds,
            avatar: payload.avatar,
            engine: payload.engine,
            sandbox: payload.sandbox,
            runtimeMode: payload.runtimeMode,
            usageCap: payload.usageCap,
            voiceEnabled: payload.voiceEnabled,
            channelBindings: payload.channelBindings,
            groupId: payload.groupId,
            archivedAt: null,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
          };
          const existing = nextBase.bots.some((entry) => entry.id === payload.botId);
          return {
            ...nextBase,
            bots: existing
              ? nextBase.bots.map((entry) => (entry.id === payload.botId ? bot : entry))
              : [...nextBase.bots, bot],
          };
        }),
      );

    case "bot.updated":
      return decodeForEvent(BotUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          bots: updateBot(nextBase.bots, payload.botId, {
            ...(payload.name !== undefined ? { name: payload.name } : {}),
            ...(payload.title !== undefined ? { title: payload.title } : {}),
            ...(payload.label !== undefined ? { label: payload.label } : {}),
            ...(payload.description !== undefined ? { description: payload.description } : {}),
            ...(payload.disabledMcpServerIds !== undefined
              ? { disabledMcpServerIds: payload.disabledMcpServerIds }
              : {}),
            ...(payload.avatar !== undefined ? { avatar: payload.avatar } : {}),
            ...(payload.engine !== undefined ? { engine: payload.engine } : {}),
            ...(payload.sandbox !== undefined ? { sandbox: payload.sandbox } : {}),
            ...(payload.runtimeMode !== undefined ? { runtimeMode: payload.runtimeMode } : {}),
            ...(payload.usageCap !== undefined ? { usageCap: payload.usageCap } : {}),
            ...(payload.voiceEnabled !== undefined ? { voiceEnabled: payload.voiceEnabled } : {}),
            ...(payload.channelBindings !== undefined
              ? { channelBindings: payload.channelBindings }
              : {}),
            ...(payload.groupId !== undefined ? { groupId: payload.groupId } : {}),
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "bot.archived":
      return decodeForEvent(BotArchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          bots: updateBot(nextBase.bots, payload.botId, {
            archivedAt: payload.archivedAt,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "bot.restored":
      return decodeForEvent(BotRestoredPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          bots: updateBot(nextBase.bots, payload.botId, {
            archivedAt: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "group.created":
      return decodeForEvent(GroupCreatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const group: OrchestrationGroup = {
            id: payload.groupId,
            name: payload.name,
            bossBotId: payload.bossBotId,
            members: payload.members,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
          };
          const existing = nextBase.groups.some((entry) => entry.id === payload.groupId);
          return {
            ...nextBase,
            groups: existing
              ? nextBase.groups.map((entry) => (entry.id === payload.groupId ? group : entry))
              : [...nextBase.groups, group],
          };
        }),
      );

    case "group.renamed":
      return decodeForEvent(GroupRenamedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          groups: nextBase.groups.map((group) =>
            group.id === payload.groupId
              ? { ...group, name: payload.name, updatedAt: payload.updatedAt }
              : group,
          ),
        })),
      );

    case "group.member-assigned":
      return decodeForEvent(GroupMemberAssignedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const group = nextBase.groups.find((entry) => entry.id === payload.groupId);
          if (!group) return nextBase;
          const members = group.members.some(
            (member) => isGroupBotMember(member) && member.botId === payload.member.botId,
          )
            ? group.members.map((member) =>
                isGroupBotMember(member) && member.botId === payload.member.botId
                  ? payload.member
                  : member,
              )
            : [...group.members, payload.member];
          return {
            ...nextBase,
            groups: updateGroup(nextBase.groups, payload.groupId, {
              members,
              bossBotId: payload.member.role === "boss" ? payload.member.botId : group.bossBotId,
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "group.member-unassigned":
      return decodeForEvent(
        GroupMemberUnassignedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          groups: updateGroup(nextBase.groups, payload.groupId, {
            members:
              nextBase.groups
                .find((group) => group.id === payload.groupId)
                ?.members.filter(
                  (member) => !isGroupBotMember(member) || member.botId !== payload.botId,
                ) ?? [],
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "group.person-assigned":
      return decodeForEvent(GroupPersonAssignedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const group = nextBase.groups.find((entry) => entry.id === payload.groupId);
          if (!group) return nextBase;
          const members = [
            ...group.members.filter(
              (member) => member.kind !== "person" || member.personId !== payload.person.personId,
            ),
            payload.person,
          ];
          return {
            ...nextBase,
            groups: updateGroup(nextBase.groups, payload.groupId, {
              members,
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "group.person-unassigned":
      return decodeForEvent(
        GroupPersonUnassignedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          groups: updateGroup(nextBase.groups, payload.groupId, {
            members:
              nextBase.groups
                .find((group) => group.id === payload.groupId)
                ?.members.filter(
                  (member) => member.kind !== "person" || member.personId !== payload.personId,
                ) ?? [],
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "group.boss-set":
      return decodeForEvent(GroupBossSetPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const group = nextBase.groups.find((entry) => entry.id === payload.groupId);
          if (!group) return nextBase;
          let members = group.members.filter(
            (member) => !isGroupBotMember(member) || member.botId !== payload.bossBotId,
          );
          if (payload.previousBossBotId !== null) {
            members = members.filter(
              (member) => !isGroupBotMember(member) || member.botId !== payload.previousBossBotId,
            );
            if (payload.previousBossRole === "specialist") {
              members = [
                ...members,
                { kind: "bot", botId: payload.previousBossBotId, role: "specialist" },
              ];
            }
          }
          members = [...members, { kind: "bot", botId: payload.bossBotId, role: "boss" }];
          return {
            ...nextBase,
            groups: updateGroup(nextBase.groups, payload.groupId, {
              bossBotId: payload.bossBotId,
              members,
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "mcp-server.created":
    case "mcp-server.updated":
    case "mcp-server.enabled":
    case "mcp-server.disabled": {
      return decodeForEvent(McpServerCreatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const mcpServers = nextBase.mcpServers ?? [];
          return {
            ...nextBase,
            mcpServers: mcpServers.some((entry) => entry.id === payload.mcpServer.id)
              ? mcpServers.map((entry) =>
                  entry.id === payload.mcpServer.id ? payload.mcpServer : entry,
                )
              : [...mcpServers, payload.mcpServer],
          };
        }),
      );
    }

    case "mcp-server.deleted":
      return decodeForEvent(McpServerDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          mcpServers: (nextBase.mcpServers ?? []).filter(
            (entry) => entry.id !== payload.mcpServerId,
          ),
        })),
      );

    case "group.deleted":
      return decodeForEvent(GroupDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          groups: nextBase.groups.filter((group) => group.id !== payload.groupId),
        })),
      );

    case "thread.created":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadCreatedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread: OrchestrationThread = yield* decodeForEvent(
          OrchestrationThread,
          {
            id: payload.threadId,
            projectId: payload.projectId,
            botId: payload.botId ?? null,
            groupId: payload.groupId ?? null,
            respondingBotId: null,
            title: payload.title,
            modelSelection: payload.modelSelection,
            runtimeMode: payload.runtimeMode,
            interactionMode: payload.interactionMode,
            branch: payload.branch,
            worktreePath: payload.worktreePath,
            latestTurn: null,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            unsettledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            deletedAt: null,
            messages: [],
            activities: [],
            checkpoints: [],
            session: null,
          },
          event.type,
          "thread",
        );
        const existing = nextBase.threads.find((entry) => entry.id === thread.id);
        return {
          ...nextBase,
          threads: existing
            ? nextBase.threads.map((entry) => (entry.id === thread.id ? thread : entry))
            : [...nextBase.threads, thread],
        };
      });

    case "thread.ownership-updated":
      return decodeForEvent(
        ThreadOwnershipUpdatedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            botId: payload.botId,
            groupId: payload.groupId,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.deleted":
      return decodeForEvent(ThreadDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            deletedAt: payload.deletedAt,
            updatedAt: payload.deletedAt,
          }),
        })),
      );

    case "thread.archived":
      return decodeForEvent(ThreadArchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            archivedAt: payload.archivedAt,
            titleRegeneration: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.unarchived":
      return decodeForEvent(ThreadUnarchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            archivedAt: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.settled":
      return decodeForEvent(ThreadSettledPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            settledOverride: "settled",
            settledAt: payload.settledAt,
            unsettledAt: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.unsettled":
      return decodeForEvent(ThreadUnsettledPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existing = nextBase.threads.find((thread) => thread.id === payload.threadId);
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              settledOverride: payload.reason === "user" ? "active" : null,
              settledAt: null,
              // Re-entry stamp for active-list ordering. A thread already
              // pinned active keeps its stamp: the activity reset that clears
              // the pin is not a re-entry and must not reorder the list.
              unsettledAt:
                existing?.settledOverride === "active"
                  ? (existing.unsettledAt ?? null)
                  : payload.updatedAt,
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.snoozed":
      return decodeForEvent(ThreadSnoozedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            snoozedUntil: payload.snoozedUntil,
            snoozedAt: payload.snoozedAt,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.unsnoozed":
      return decodeForEvent(ThreadUnsnoozedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            snoozedUntil: null,
            snoozedAt: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.pinned":
      return decodeForEvent(ThreadPinnedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            pinnedAt: payload.pinnedAt,
            ...(payload.pinOrderKey !== undefined ? { pinOrderKey: payload.pinOrderKey } : {}),
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.unpinned":
      return decodeForEvent(ThreadUnpinnedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            pinnedAt: null,
            // Unpin clears the slot: re-pinning is "pin again", not "restore
            // an ancient position".
            pinOrderKey: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.pin-reordered":
      return decodeForEvent(ThreadPinReorderedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            pinOrderKey: payload.orderKey,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.meta-updated":
      return decodeForEvent(ThreadMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            ...(payload.title !== undefined ? { title: payload.title } : {}),
            ...(payload.titleRegeneration !== undefined
              ? { titleRegeneration: payload.titleRegeneration }
              : {}),
            ...(payload.modelSelection !== undefined
              ? { modelSelection: payload.modelSelection }
              : {}),
            ...(payload.branch !== undefined ? { branch: payload.branch } : {}),
            ...(payload.worktreePath !== undefined ? { worktreePath: payload.worktreePath } : {}),
            ...(payload.linkedPullRequest !== undefined
              ? { linkedPullRequest: payload.linkedPullRequest }
              : {}),
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.runtime-mode-set":
      return decodeForEvent(ThreadRuntimeModeSetPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            runtimeMode: payload.runtimeMode,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.interaction-mode-set":
      return decodeForEvent(
        ThreadInteractionModeSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            interactionMode: payload.interactionMode,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.message-sent":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          MessageSentPayloadSchema,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const message: OrchestrationMessage = yield* decodeForEvent(
          OrchestrationMessage,
          {
            id: payload.messageId,
            role: payload.role,
            text: payload.text,
            ...(payload.attachments !== undefined ? { attachments: payload.attachments } : {}),
            turnId: payload.turnId,
            ...(payload.respondingBotId !== undefined
              ? { respondingBotId: payload.respondingBotId }
              : {}),
            ...(payload.authorPersonId !== undefined
              ? { authorPersonId: payload.authorPersonId }
              : {}),
            ...(payload.authorDisplayName !== undefined
              ? { authorDisplayName: payload.authorDisplayName }
              : {}),
            ...(payload.channelOrigin !== undefined
              ? { channelOrigin: payload.channelOrigin }
              : {}),
            streaming: payload.streaming,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
          },
          event.type,
          "message",
        );

        const existingMessage = thread.messages.find((entry) => entry.id === message.id);
        const messages = existingMessage
          ? thread.messages.map((entry) =>
              entry.id === message.id
                ? {
                    ...entry,
                    text: message.streaming
                      ? `${entry.text}${message.text}`
                      : message.text.length > 0
                        ? message.text
                        : entry.text,
                    streaming: message.streaming,
                    updatedAt: message.updatedAt,
                    turnId: message.turnId,
                    ...(message.respondingBotId !== undefined
                      ? { respondingBotId: message.respondingBotId }
                      : {}),
                    ...(message.attachments !== undefined
                      ? { attachments: message.attachments }
                      : {}),
                  }
                : entry,
            )
          : [...thread.messages, message];
        const cappedMessages = messages.slice(-MAX_THREAD_MESSAGES);

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            messages: cappedMessages,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.message-reaction-set":
      return decodeForEvent(
        ThreadMessageReactionSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) return nextBase;
          const messages = thread.messages.map((message) => {
            if (message.id !== payload.messageId) return message;
            const withoutReaction = (message.reactions ?? []).filter(
              (reaction) => reaction.botId !== payload.botId || reaction.emoji !== payload.emoji,
            );
            return {
              ...message,
              reactions: payload.present
                ? [...withoutReaction, { botId: payload.botId, emoji: payload.emoji }]
                : withoutReaction,
              updatedAt: payload.updatedAt,
            };
          });
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              messages,
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.turn-start-requested":
      return decodeForEvent(
        ThreadTurnStartRequestedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            respondingBotId: payload.respondingBotId ?? null,
            updatedAt: event.occurredAt,
          }),
        })),
      );

    case "thread.session-set":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadSessionSetPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const session: OrchestrationSession = yield* decodeForEvent(
          OrchestrationSession,
          payload.session,
          event.type,
          "session",
        );

        // Leaving the "running" session status is the turn-end signal: settle
        // a still-running latest turn so its duration reflects the whole turn.
        const settledTurnState = settledTurnStateForSessionStatus(session.status);
        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            session,
            latestTurn:
              session.status === "running" && session.activeTurnId !== null
                ? {
                    turnId: session.activeTurnId,
                    state: "running",
                    requestedAt:
                      thread.latestTurn?.turnId === session.activeTurnId
                        ? thread.latestTurn.requestedAt
                        : session.updatedAt,
                    startedAt:
                      thread.latestTurn?.turnId === session.activeTurnId
                        ? (thread.latestTurn.startedAt ?? session.updatedAt)
                        : session.updatedAt,
                    completedAt: null,
                    assistantMessageId:
                      thread.latestTurn?.turnId === session.activeTurnId
                        ? thread.latestTurn.assistantMessageId
                        : null,
                    respondingBotId: thread.respondingBotId ?? null,
                  }
                : thread.latestTurn !== null &&
                    thread.latestTurn.state === "running" &&
                    settledTurnState !== null
                  ? {
                      ...thread.latestTurn,
                      state: settledTurnState,
                      // A running turn's completedAt can only hold a mid-turn
                      // placeholder checkpoint timestamp — the session leaving
                      // "running" is the authoritative turn end.
                      completedAt: session.updatedAt,
                    }
                  : thread.latestTurn,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.proposed-plan-upserted":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadProposedPlanUpsertedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const proposedPlans = [
          ...thread.proposedPlans.filter((entry) => entry.id !== payload.proposedPlan.id),
          payload.proposedPlan,
        ]
          .toSorted(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
          )
          .slice(-200);

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            proposedPlans,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.turn-diff-completed":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadTurnDiffCompletedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const checkpoint = yield* decodeForEvent(
          OrchestrationCheckpointSummary,
          {
            turnId: payload.turnId,
            checkpointTurnCount: payload.checkpointTurnCount,
            checkpointRef: payload.checkpointRef,
            status: payload.status,
            files: payload.files,
            assistantMessageId: payload.assistantMessageId,
            completedAt: payload.completedAt,
          },
          event.type,
          "checkpoint",
        );

        // Do not let a placeholder (status "missing") overwrite a checkpoint
        // that has already been captured with a real git ref (status "ready").
        // ProviderRuntimeIngestion may fire multiple turn.diff.updated events
        // per turn; without this guard later placeholders would clobber the
        // real capture dispatched by CheckpointReactor.
        const existing = thread.checkpoints.find((entry) => entry.turnId === checkpoint.turnId);
        if (existing && existing.status !== "missing" && checkpoint.status === "missing") {
          return nextBase;
        }

        const checkpoints = [
          ...thread.checkpoints.filter((entry) => entry.turnId !== checkpoint.turnId),
          checkpoint,
        ]
          .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
          .slice(-MAX_THREAD_CHECKPOINTS);

        // Mid-turn diff updates produce placeholder checkpoints; record the
        // checkpoint, but don't settle a turn its session is still running.
        const turnStillRunning =
          thread.session?.status === "running" && thread.session.activeTurnId === payload.turnId;

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            checkpoints,
            latestTurn: turnStillRunning
              ? thread.latestTurn
              : {
                  turnId: payload.turnId,
                  state: checkpointStatusToLatestTurnState(payload.status),
                  requestedAt:
                    thread.latestTurn?.turnId === payload.turnId
                      ? thread.latestTurn.requestedAt
                      : payload.completedAt,
                  startedAt:
                    thread.latestTurn?.turnId === payload.turnId
                      ? (thread.latestTurn.startedAt ?? payload.completedAt)
                      : payload.completedAt,
                  completedAt: payload.completedAt,
                  assistantMessageId: payload.assistantMessageId,
                  respondingBotId: thread.respondingBotId ?? null,
                },
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.reverted":
      return decodeForEvent(ThreadRevertedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          const checkpoints = thread.checkpoints
            .filter((entry) => entry.checkpointTurnCount <= payload.turnCount)
            .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
            .slice(-MAX_THREAD_CHECKPOINTS);
          const retainedTurnIds = new Set(checkpoints.map((checkpoint) => checkpoint.turnId));
          const messages = retainThreadMessagesAfterRevert(
            thread.messages,
            retainedTurnIds,
            payload.turnCount,
          ).slice(-MAX_THREAD_MESSAGES);
          const proposedPlans = retainThreadProposedPlansAfterRevert(
            thread.proposedPlans,
            retainedTurnIds,
          ).slice(-200);
          const activities = retainThreadActivitiesAfterRevert(thread.activities, retainedTurnIds);

          const latestCheckpoint = checkpoints.at(-1) ?? null;
          const latestTurn =
            latestCheckpoint === null
              ? null
              : {
                  turnId: latestCheckpoint.turnId,
                  state: checkpointStatusToLatestTurnState(latestCheckpoint.status),
                  requestedAt: latestCheckpoint.completedAt,
                  startedAt: latestCheckpoint.completedAt,
                  completedAt: latestCheckpoint.completedAt,
                  assistantMessageId: latestCheckpoint.assistantMessageId,
                };

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              checkpoints,
              messages,
              proposedPlans,
              activities,
              latestTurn,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    case "thread.activity-appended":
      return decodeForEvent(
        ThreadActivityAppendedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          const activities = [
            ...thread.activities.filter((entry) => entry.id !== payload.activity.id),
            payload.activity,
          ]
            .toSorted(compareThreadActivities)
            .slice(-500);

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              activities,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    default:
      return Effect.succeed(nextBase);
  }
}
