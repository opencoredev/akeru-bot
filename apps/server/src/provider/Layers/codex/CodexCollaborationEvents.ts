import { readProtocolRecord } from "../ProtocolJson.ts";
import type * as Schema from "effect/Schema";
import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import {
  type ProviderEvent,
  type ProviderRuntimeEvent,
  RuntimeTaskId,
  type RuntimeTaskUsage,
  ThreadId,
} from "@akeru/contracts";

import { toCanonicalItemType } from "./CodexCanonicalMapping.ts";
import { runtimeEventBase } from "./CodexEventIdentity.ts";

/**
 * Maps the session runtime's synthetic `collabAgent/*` events (native
 * multi-agent v2 child-thread signals) into the shared task.* lifecycle.
 * Agent identity = child thread id; nickname is the display title, role is
 * agentRole (fallback: last agentPath segment, then "general-purpose").
 * A completed child turn is idle (resumable), not terminal. timelineBypass
 * keeps these rows out of the parent chat.
 */
export function mapCollabAgentEvent(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = readProtocolRecord(event.payload);

  const agentThreadId = Predicate.isString(payload?.agentThreadId) ? payload.agentThreadId : "";

  if (!payload || agentThreadId.length === 0) {
    return [];
  }

  const base = runtimeEventBase(event, canonicalThreadId);
  const taskId = RuntimeTaskId.make(agentThreadId);
  const agentPath = Predicate.isString(payload.agentPath) ? payload.agentPath : undefined;
  const pathLeaf = agentPath?.split("/").findLast((segment) => segment.length > 0);
  const nickname = Predicate.isString(payload.nickname) ? payload.nickname : undefined;

  const role =
    (Predicate.isString(payload.role) ? payload.role : undefined) ?? pathLeaf ?? "general-purpose";

  // A bare thread id is not a name. Omitting the title lets the client fold
  // keep the real one from task.started instead of clobbering it (probe
  // finding: progress rows renamed math_one to its UUID).
  const knownName = nickname ?? pathLeaf;
  const title = knownName ?? agentThreadId;

  // Identity repeated on every status patch so rows are self-describing when
  // the start row ages out of activity retention (review finding: a
  // reconstructed agent had a UUID name and no role/path).
  const statusLinkage = {
    role,
    ...(knownName ? { title: knownName } : {}),
    ...(agentPath ? { agentPath } : {}),
    timelineBypass: true,
  } as const;

  switch (event.method) {
    case "collabAgent/started":
      return [
        {
          ...base,
          type: "task.started",
          payload: {
            taskId,
            description: title,
            title,
            role,
            ...(agentPath ? { agentPath } : {}),
            ...(Predicate.isString(payload.parentThreadId)
              ? { parentAgentId: payload.parentThreadId }
              : {}),
            timelineBypass: true,
          },
        },
      ];
    case "collabAgent/activity": {
      const activityKind = Predicate.isString(payload.activityKind) ? payload.activityKind : "";

      if (activityKind === "interrupted") {
        return [
          {
            ...base,
            type: "task.updated",
            payload: { taskId, status: "interrupted", ...statusLinkage },
          },
        ];
      }

      if (activityKind === "started") {
        // Wire-probe finding: children often register via subAgentActivity
        // alone (no thread/started with a spawn source), so this is the one
        // shot at a task.started with a real name — agentPath leaf beats a
        // bare thread-id title.
        return [
          {
            ...base,
            type: "task.started",
            payload: {
              taskId,
              description: title,
              title,
              role,
              ...(agentPath ? { agentPath } : {}),
              timelineBypass: true,
            },
          },
        ];
      }

      // Reading a child's result also emits "interacted" after its turn is idle.
      // Only the child's turn or thread lifecycle can prove it resumed work.
      return [];
    }

    case "collabAgent/turnStarted":
      return [
        {
          ...base,
          type: "task.updated",
          payload: { taskId, status: "running", ...statusLinkage },
        },
      ];
    case "collabAgent/turnCompleted": {
      // Idle, not terminal: the identity is resumable via sendInput/resume.
      const turn = readProtocolRecord(payload.turn);

      const turnStatus = Predicate.isString(turn?.status) ? turn.status : undefined;

      const status = Match.value(turnStatus).pipe(
        Match.when("failed", () => "failed" as const),
        Match.when("interrupted", () => "interrupted" as const),
        Match.orElse(() => "idle" as const),
      );

      return [
        {
          ...base,
          type: "task.updated",
          payload: { taskId, status, ...statusLinkage },
        },
      ];
    }

    case "collabAgent/statusChanged": {
      const status = readProtocolRecord(payload.status);

      const statusType = Predicate.isString(status?.type) ? status.type : undefined;

      if (statusType === "systemError") {
        // Silently dropping this once left children stuck running forever.
        return [
          {
            ...base,
            type: "task.updated",
            payload: { taskId, status: "failed", ...statusLinkage },
          },
        ];
      }

      if (statusType === "active") {
        const flags = Array.isArray(status?.activeFlags) ? status.activeFlags : [];

        const waiting = flags.some(
          (flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput",
        );

        return [
          {
            ...base,
            type: "task.updated",
            payload: { taskId, status: waiting ? "waiting" : "running", ...statusLinkage },
          },
        ];
      }

      if (statusType === "idle") {
        return [
          {
            ...base,
            type: "task.updated",
            payload: { taskId, status: "idle", ...statusLinkage },
          },
        ];
      }

      return [];
    }

    case "collabAgent/tokenUsage": {
      // Cumulative per child thread: always the `total` breakdown, never
      // `last` (which shrinks on follow-ups). Client folds max-merge.
      const tokenUsage = readProtocolRecord(payload.tokenUsage);

      const total = readProtocolRecord(tokenUsage?.total);

      const count = (value: Schema.Json | undefined): number | undefined =>
        Predicate.isNumber(value) && Number.isFinite(value) && value >= 0 ? value : undefined;

      // Same validation as every other field: RuntimeTaskUsage.totalTokens
      // is NonNegativeInt, so NaN/Infinity/negative wire values must miss.
      const totalTokens = count(total?.totalTokens);

      if (totalTokens === undefined) {
        return [];
      }

      const typedUsage: RuntimeTaskUsage = {
        totalTokens,
        ...(count(total?.inputTokens) !== undefined
          ? { inputTokens: count(total?.inputTokens) }
          : {}),
        ...(count(total?.cachedInputTokens) !== undefined
          ? { cachedInputTokens: count(total?.cachedInputTokens) }
          : {}),
        ...(count(total?.outputTokens) !== undefined
          ? { outputTokens: count(total?.outputTokens) }
          : {}),
        ...(count(total?.reasoningOutputTokens) !== undefined
          ? { reasoningOutputTokens: count(total?.reasoningOutputTokens) }
          : {}),
      };

      return [
        {
          ...base,
          type: "task.progress",
          payload: {
            taskId,
            description: title,
            ...(knownName ? { title: knownName } : {}),
            typedUsage,
            timelineBypass: true,
          },
        },
      ];
    }

    case "collabAgent/item": {
      const item = readProtocolRecord(payload.item);

      const itemTypeRaw = Predicate.isString(item?.type) ? item.type : undefined;

      if (!itemTypeRaw) {
        return [];
      }

      // A loose summary from the raw item: the child stream is untyped at
      // this boundary (synthetic event payload), so read best-effort fields
      // rather than force a schema decode.
      const looseSummary =
        (Predicate.isString(item?.command) ? item.command : undefined) ??
        (Predicate.isString(item?.title) ? item.title : undefined) ??
        (Predicate.isString(item?.query) ? item.query : undefined);

      const canonical = toCanonicalItemType(itemTypeRaw);
      const summary = looseSummary ?? canonical.replaceAll("_", " ");

      return [
        {
          ...base,
          type: "task.progress",
          payload: {
            taskId,
            description: title,
            ...(knownName ? { title: knownName } : {}),
            summary,
            timelineBypass: true,
          },
        },
      ];
    }

    case "collabAgent/closed":
      return [
        {
          ...base,
          type: "task.updated",
          payload: { taskId, status: "interrupted", ...statusLinkage },
        },
      ];
    default:
      return [];
  }
}
