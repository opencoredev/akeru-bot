import { readProtocolRecord } from "../ProtocolJson.ts";
import type { AkeruRuntimeSeam } from "../../AkeruRuntimeSeam.ts";
import type { AgentControllerLiveOptions } from "./Options.ts";
// @effect-diagnostics globalDate:off globalConsole:off globalRandom:off nodeBuiltinImport:off globalTimers:off globalFetch:off

import {
  type AkeruDelegationAccessGrant,
  type AkeruMemoryDocumentTarget,
  type AkeruMemoryThreadAccess,
} from "@akeru/contracts";

import * as Effect from "effect/Effect";

import * as Option from "effect/Option";

import { BotMemoryStore, type BotMemoryAccess } from "../../../memory/BotMemory.ts";
import {
  createBotMemoryToolHandler,
  type AkeruMemoryShareFact,
  type AkeruMemoryToolHandler,
} from "../../../memory/BotMemoryToolHandlers.ts";

import { buildProviderMemoryPacket } from "../../../memory/ProviderMemoryPacket.ts";

import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

import { MemoryApprovals } from "../../../memory/MemoryApprovals.ts";

export function createMemoryAccess(deps: {
  readonly runPromise: AkeruRuntimeSeam["runPromise"];
  readonly projectionSnapshotQuery: Option.Option<ProjectionSnapshotQuery["Service"]>;
  readonly options: AgentControllerLiveOptions | undefined;
  readonly memorySettings: () =>
    | Effect.Effect<
        | { enabled: boolean; privateBotMemory: boolean; sharedProjectMemory: "auto" | "ask" }
        | { enabled: boolean; privateBotMemory: boolean; sharedProjectMemory: "ask" },
        never,
        never
      >
    | Effect.Effect<
        {
          readonly enabled: true;
          readonly privateBotMemory: true;
          readonly sharedProjectMemory: "ask";
        },
        never,
        never
      >;
  readonly memoryApprovals: Option.Option<MemoryApprovals["Service"]>;
  readonly botMemoryStore: BotMemoryStore;
}) {
  const memoryApprovals = deps.memoryApprovals;

  const memoryAccessFor = (
    access: AkeruMemoryThreadAccess | undefined,
  ): BotMemoryAccess | undefined => {
    const botId = access?.respondingBotId ?? access?.botId;

    return access && botId
      ? {
          botId,
          groupId: access.groupId,
          groupMemberBotIds: access.groupMemberBotIds,
        }
      : undefined;
  };

  const refreshEntityMemoryAccess = async (
    access: AkeruMemoryThreadAccess | undefined,
  ): Promise<AkeruMemoryThreadAccess | undefined> => {
    if (!access || access.groupId === null) return access;

    // Without a projection the membership cannot be rechecked. The access stays a group
    // access with no members, so it reads neither group facts nor the bot's private ones.
    if (Option.isNone(deps.projectionSnapshotQuery)) {
      return { ...access, groupMemberBotIds: [] };
    }

    const snapshot = await deps.runPromise(deps.projectionSnapshotQuery.value.getSnapshot());
    const group = snapshot.groups.find((candidate) => candidate.id === access.groupId);

    if (!group) return undefined;

    const groupMemberBotIds = group.members
      .filter((member) => member.kind === "bot")
      .map((member) => member.botId);

    const respondingBotId = access.respondingBotId ?? access.botId;

    if (respondingBotId === null || !groupMemberBotIds.includes(respondingBotId)) return undefined;

    return { ...access, groupMemberBotIds };
  };

  const entityMemoryContext = async (
    access: AkeruMemoryThreadAccess | undefined,
  ): Promise<string> => {
    const current = await refreshEntityMemoryAccess(access);

    if (!current || !deps.options?.entityMemoryRepository) return "";

    if (current.groupId !== null && current.groupMemberBotIds.length === 0) return "";

    const currentRevisions = await deps.runPromise(
      deps.options.entityMemoryRepository.listCurrent({ access: current }),
    );

    // Memory inspection and export still list bot-private facts; only the
    // provider packet honours the Private bot memory switch.
    const { privateBotMemory } = await deps.runPromise(deps.memorySettings());

    const revisions = privateBotMemory
      ? currentRevisions
      : currentRevisions.filter(
          (revision) =>
            revision.partition.scope !== "bot" && revision.partition.scope !== "bot-user",
        );

    await deps.runPromise(
      deps.options.entityMemoryRepository.recordDerivedCopies?.({
        tenantId: current.tenantId,
        threadId: String(current.threadId),
        revisions,
      }) ?? Effect.void,
    );
    const packet = buildProviderMemoryPacket(current.threadId, revisions);

    return packet.rendered ? `<entity-memory>\n${packet.rendered}\n</entity-memory>` : "";
  };

  const memoryHandlers = (
    access: AkeruMemoryThreadAccess | undefined,
    allowedScopes: AkeruDelegationAccessGrant["memoryScopes"],
  ) => {
    const resolved = memoryAccessFor(access);

    if (!resolved) return undefined;
    const scopes = new Set(allowedScopes);
    const targets = new Set<AkeruMemoryDocumentTarget>();

    if (scopes.has("private")) targets.add("user");

    if (scopes.has("bot")) targets.add("memory");

    if (resolved.groupId !== null && scopes.has("group")) targets.add("group");

    const canShare =
      scopes.has("project") ||
      scopes.has("workspace") ||
      (resolved.groupId !== null && scopes.has("group"));

    if (targets.size === 0 && !(canShare && Option.isSome(memoryApprovals))) return undefined;

    // Shared facts go through MemoryApprovals, which saves them directly in
    // auto mode or opens an approval card and inbox item in ask mode.
    const shareFact: AkeruMemoryShareFact | undefined =
      access && Option.isSome(memoryApprovals)
        ? async (request) => {
            if (!scopes.has(request.scope)) {
              throw new Error(
                `The ${request.scope} memory scope is outside this bot's access grant.`,
              );
            }

            if (request.scope === "group" && access.groupId === null) {
              throw new Error("Group memory is available only in a group chat.");
            }

            const settings = await deps.runPromise(deps.memorySettings());

            const result = await deps.runPromise(
              memoryApprovals.value.propose({
                access,
                fact: request.fact,
                scope: request.scope,
                sensitive: request.sensitive,
                mode: settings.sharedProjectMemory,
              }),
            );

            return { status: result.status };
          }
        : undefined;

    const handler = createBotMemoryToolHandler(
      deps.botMemoryStore,
      resolved,
      targets,
      shareFact,
    ).memory;

    // The memory settings gate is enforced at call time: a handler captured
    // while Memory was on must deny calls after it is turned off, and a
    // "Private bot memory" toggle applies without rebuilding the session.
    const guarded: AkeruMemoryToolHandler = async (input) => {
      const settings = await deps.runPromise(deps.memorySettings());

      if (!settings.enabled) {
        throw new Error("Bot memory is disabled.");
      }

      if (!settings.privateBotMemory) {
        const memoryInput = readProtocolRecord(input.input);
        const target = memoryInput?.target;
        const operations = memoryInput?.operations;
        const share = memoryInput?.share;

        // A share-only call never reads or changes the target document.
        const shareOnly =
          share !== undefined && Array.isArray(operations) && operations.length === 0;

        if (target === "memory" && !shareOnly) {
          throw new Error("Private bot memory is disabled.");
        }
      }

      return handler(input);
    };

    return { memory: guarded };
  };

  return { memoryAccessFor, refreshEntityMemoryAccess, entityMemoryContext, memoryHandlers };
}
