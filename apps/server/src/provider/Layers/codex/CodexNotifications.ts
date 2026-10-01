// @effect-diagnostics globalDate:off globalConsole:off globalRandom:off nodeBuiltinImport:off globalTimers:off globalFetch:off
import {
  ApprovalRequestId,
  type ProviderEvent,
  type ProviderRequestKind,
  type ProviderSession,
  TurnId,
} from "@akeru/contracts";

import * as Effect from "effect/Effect";

import * as Ref from "effect/Ref";

import * as CodexErrors from "effect-codex-app-server/errors";

import { type CodexSessionRuntimeOptions, type ApprovalCorrelation } from "./CodexRuntimeState.ts";

import {
  type CodexServerNotification,
  readNotificationThreadId,
  readRouteFields,
  type CollabChildAgentState,
  readThreadSpawnSource,
  rememberCollabReceiverTurns,
  shouldSuppressChildConversationNotification,
  routeCodexChildNotification,
} from "./CodexRuntimeNotifications.ts";
import { currentProviderThreadId } from "./CodexRuntimeSessions.ts";

export function createCodexNotifications(deps: {
  readonly collabChildAgentsRef: Ref.Ref<Map<string, CollabChildAgentState>>;
  readonly sessionRef: Ref.Ref<ProviderSession>;
  readonly emitEvent: (
    event: Omit<ProviderEvent, "id" | "provider" | "createdAt">,
  ) => Effect.Effect<void, CodexErrors.CodexAppServerIdentifierGenerationError, never>;
  readonly options: CodexSessionRuntimeOptions;
  readonly collabChildLiveTurnsRef: Ref.Ref<Map<string, string>>;
  readonly suppressMemoryConsolidationNotification: (
    notification: CodexServerNotification,
  ) => boolean;
  readonly collabReceiverTurnsRef: Ref.Ref<Map<string, TurnId>>;
  readonly approvalCorrelationsRef: Ref.Ref<Map<string, ApprovalCorrelation>>;
}) {
  const interceptCollabChildNotification = (notification: CodexServerNotification) =>
    Effect.gen(function* () {
      // Registration path 1: child thread announces itself with a
      // subAgent thread_spawn source.
      if (notification.method === "thread/started") {
        const thread = notification.params.thread;
        const spawn = readThreadSpawnSource(thread);

        if (!spawn) {
          return false;
        }

        // Merge with any subAgentActivity registration that got here
        // first. spawnTurnId is REGISTRATION-time-only on both paths: for
        // an already-known child we keep its value (set or unset) — a
        // later thread/started during an unrelated parent turn must not
        // backfill that turn as the spawn batch, which would stamp an old
        // child onto a new fleet's CTA (review finding). Only a genuinely
        // new registration captures the current turn.
        const existingChild = (yield* Ref.get(deps.collabChildAgentsRef)).get(thread.id);

        const spawnTurnId = existingChild
          ? existingChild.spawnTurnId
          : ((yield* Ref.get(deps.sessionRef)).activeTurnId ?? undefined);

        const state: CollabChildAgentState = {
          agentThreadId: thread.id,
          nickname: spawn.nickname ?? thread.agentNickname ?? existingChild?.nickname,
          role: spawn.role ?? thread.agentRole ?? existingChild?.role,
          agentPath: spawn.agentPath ?? existingChild?.agentPath,
          depth: spawn.depth ?? existingChild?.depth,
          parentThreadId:
            spawn.parentThreadId ?? thread.parentThreadId ?? existingChild?.parentThreadId,
          spawnTurnId,
        };

        yield* Ref.update(deps.collabChildAgentsRef, (current) => {
          const next = new Map(current);
          next.set(thread.id, state);

          return next;
        });
        yield* deps.emitEvent({
          kind: "notification",
          threadId: deps.options.threadId,
          method: "collabAgent/started",
          ...(state.spawnTurnId ? { turnId: state.spawnTurnId } : {}),
          payload: {
            agentThreadId: state.agentThreadId,
            ...(state.nickname ? { nickname: state.nickname } : {}),
            ...(state.role ? { role: state.role } : {}),
            ...(state.agentPath ? { agentPath: state.agentPath } : {}),
            ...(state.depth !== undefined ? { depth: state.depth } : {}),
            ...(state.parentThreadId ? { parentThreadId: state.parentThreadId } : {}),
          },
        });

        return true;
      }

      // Registration path 2: parent-side subAgentActivity item names the
      // child thread (may arrive before or after thread/started).
      if (
        (notification.method === "item/started" || notification.method === "item/completed") &&
        notification.params.item.type === "subAgentActivity"
      ) {
        const item = notification.params.item;
        // Never register the session's ROOT thread as its own child. The
        // wire emits subAgentActivity {agentPath: "/root", interacted}
        // about the root during collab runs; registering it intercepted
        // every subsequent root notification — including the final
        // assistant message and turn/completed — so the thread hung
        // "working" after all subagents finished (live-probe finding).
        const rootProviderThreadId = currentProviderThreadId(yield* Ref.get(deps.sessionRef));

        if (
          item.agentThreadId === rootProviderThreadId ||
          item.agentPath === "/root" ||
          item.agentPath === "/"
        ) {
          return false;
        }

        const activitySpawnTurnId = (yield* Ref.get(deps.sessionRef)).activeTurnId ?? undefined;
        yield* Ref.update(deps.collabChildAgentsRef, (current) => {
          const existing = current.get(item.agentThreadId);
          const next = new Map(current);
          // Merge-late semantics: when thread/started registered first, a
          // later subAgentActivity still carries the real agentPath (and a
          // derived nickname) — fill missing fields, never clobber known
          // ones. spawnTurnId is registration-time-only: for an already
          // registered child, a later activity during an UNRELATED turn
          // must not backfill that turn as the spawn batch (review
          // finding); an unset spawn turn stays unset.
          next.set(item.agentThreadId, {
            agentThreadId: item.agentThreadId,
            nickname:
              existing?.nickname ??
              item.agentPath.split("/").findLast((segment) => segment.length > 0),
            role: existing?.role,
            agentPath: existing?.agentPath ?? item.agentPath,
            depth: existing?.depth,
            parentThreadId: existing?.parentThreadId,
            spawnTurnId: existing ? existing.spawnTurnId : activitySpawnTurnId,
          });

          return next;
        });
        const registeredChild = (yield* Ref.get(deps.collabChildAgentsRef)).get(item.agentThreadId);
        yield* deps.emitEvent({
          kind: "notification",
          threadId: deps.options.threadId,
          method: "collabAgent/activity",
          ...(registeredChild?.spawnTurnId ? { turnId: registeredChild.spawnTurnId } : {}),
          payload: {
            agentThreadId: item.agentThreadId,
            agentPath: item.agentPath,
            activityKind: item.kind,
          },
        });

        return true;
      }

      // Interception: notifications addressed to a registered child thread
      // become agent-scoped synthetic events instead of parent chatter.
      const providerConversationId = readNotificationThreadId(notification);

      if (!providerConversationId) {
        return false;
      }

      // Belt-and-braces: the root thread's traffic must never be
      // intercepted, whatever the registry says.
      const interceptRootId = currentProviderThreadId(yield* Ref.get(deps.sessionRef));

      if (providerConversationId === interceptRootId) {
        return false;
      }

      const children = yield* Ref.get(deps.collabChildAgentsRef);
      const child = children.get(providerConversationId);

      if (!child) {
        return false;
      }

      const childIdentity = {
        agentThreadId: child.agentThreadId,
        ...(child.nickname ? { nickname: child.nickname } : {}),
        ...(child.role ? { role: child.role } : {}),
        ...(child.agentPath ? { agentPath: child.agentPath } : {}),
      };

      switch (notification.method) {
        case "turn/started": {
          const childTurnId =
            typeof (notification.params as { turn?: { id?: unknown } }).turn?.id === "string"
              ? ((notification.params as { turn: { id: string } }).turn.id as string)
              : undefined;

          if (childTurnId) {
            yield* Ref.update(deps.collabChildLiveTurnsRef, (current) => {
              const next = new Map(current);
              next.set(child.agentThreadId, childTurnId);

              return next;
            });
          }

          yield* deps.emitEvent({
            kind: "notification",
            threadId: deps.options.threadId,
            ...(child.spawnTurnId ? { turnId: child.spawnTurnId } : {}),
            method: "collabAgent/turnStarted",
            payload: childIdentity,
          });

          return true;
        }

        case "turn/completed":
          yield* Ref.update(deps.collabChildLiveTurnsRef, (current) => {
            const next = new Map(current);
            next.delete(child.agentThreadId);

            return next;
          });
          yield* deps.emitEvent({
            kind: "notification",
            threadId: deps.options.threadId,
            ...(child.spawnTurnId ? { turnId: child.spawnTurnId } : {}),
            method: "collabAgent/turnCompleted",
            payload: {
              ...childIdentity,
              turn: notification.params.turn,
            },
          });

          return true;
        case "thread/status/changed":
          yield* deps.emitEvent({
            kind: "notification",
            threadId: deps.options.threadId,
            ...(child.spawnTurnId ? { turnId: child.spawnTurnId } : {}),
            method: "collabAgent/statusChanged",
            payload: {
              ...childIdentity,
              status: notification.params.status,
            },
          });

          return true;
        case "thread/tokenUsage/updated":
          yield* deps.emitEvent({
            kind: "notification",
            threadId: deps.options.threadId,
            ...(child.spawnTurnId ? { turnId: child.spawnTurnId } : {}),
            method: "collabAgent/tokenUsage",
            payload: {
              ...childIdentity,
              tokenUsage: notification.params.tokenUsage,
            },
          });

          return true;
        case "item/started":
        case "item/completed":
          yield* deps.emitEvent({
            kind: "notification",
            threadId: deps.options.threadId,
            ...(child.spawnTurnId ? { turnId: child.spawnTurnId } : {}),
            method: "collabAgent/item",
            payload: {
              ...childIdentity,
              item: notification.params.item,
            },
          });

          return true;
        case "thread/closed":
          // The child is gone: drop its live-turn entry so a later Stop
          // doesn't waste a turn/interrupt RPC on a closed thread before
          // reaching the parent (review finding).
          yield* Ref.update(deps.collabChildLiveTurnsRef, (current) => {
            const next = new Map(current);
            next.delete(child.agentThreadId);

            return next;
          });
          yield* deps.emitEvent({
            kind: "notification",
            threadId: deps.options.threadId,
            ...(child.spawnTurnId ? { turnId: child.spawnTurnId } : {}),
            method: "collabAgent/closed",
            payload: childIdentity,
          });

          return true;
        case "error": {
          // A child error must surface as a failed agent, not vanish into
          // the default swallow (review finding: the child stayed
          // "running" forever). Retryable errors (willRetry) keep the
          // child RUNNING and interruptible — mirroring the root error
          // handler; settling it would orphan a still-live child from
          // Stop (review finding). Terminal errors clean up the live turn
          // like thread/closed and reuse the statusChanged systemError
          // path.
          const willRetry = (notification.params as { willRetry?: boolean }).willRetry === true;

          if (willRetry) {
            return true;
          }

          yield* Ref.update(deps.collabChildLiveTurnsRef, (current) => {
            const next = new Map(current);
            next.delete(child.agentThreadId);

            return next;
          });
          yield* deps.emitEvent({
            kind: "notification",
            threadId: deps.options.threadId,
            ...(child.spawnTurnId ? { turnId: child.spawnTurnId } : {}),
            method: "collabAgent/statusChanged",
            payload: {
              ...childIdentity,
              status: { type: "systemError" },
            },
          });

          return true;
        }

        default:
          // Routing table decides (single source of truth, asserted
          // against captured wire traces): enumerated chatter is dropped,
          // everything else — including methods this build has never seen
          // — falls through to the parent path rather than vanishing.
          return routeCodexChildNotification(notification.method) === "drop";
      }
    });

  const handleRawNotification = (notification: CodexServerNotification) =>
    Effect.gen(function* () {
      const isMemoryConsolidationNotification =
        deps.suppressMemoryConsolidationNotification(notification);

      const payload = notification.params;
      const route = readRouteFields(notification);
      const collabReceiverTurns = yield* Ref.get(deps.collabReceiverTurnsRef);

      const childParentTurnId = (() => {
        const providerConversationId = readNotificationThreadId(notification);

        return providerConversationId ? collabReceiverTurns.get(providerConversationId) : undefined;
      })();

      rememberCollabReceiverTurns(collabReceiverTurns, notification, route.turnId);

      // Interception FIRST: a registered v2 child is usually also in the
      // receiver-turn map (collabAgentToolCall.receiverThreadIds), and the
      // legacy suppressor below would drop its lifecycle before it could
      // become synthetic collabAgent events (review finding). The
      // suppressor still covers UNREGISTERED children.
      if (yield* interceptCollabChildNotification(notification)) {
        yield* Ref.set(deps.collabReceiverTurnsRef, collabReceiverTurns);

        return;
      }

      // Suppression applies to receiver-map children (v1) AND to any
      // conversation that is not the root thread. The live capture
      // (codexMultiAgentWire.json) shows a child's thread/status/changed
      // arriving BEFORE anything registers the child — pre-registration
      // lifecycle must not reach the parent path, where the adapter maps
      // thread/* onto parent session state. Root-id-known guard keeps the
      // root's own early notifications flowing during session open.
      const suppressRootId = currentProviderThreadId(yield* Ref.get(deps.sessionRef));

      const foreignConversation = (() => {
        const providerConversationId = readNotificationThreadId(notification);

        return (
          providerConversationId !== undefined &&
          suppressRootId !== undefined &&
          providerConversationId !== suppressRootId
        );
      })();

      if (
        (childParentTurnId !== undefined || foreignConversation) &&
        shouldSuppressChildConversationNotification(notification.method)
      ) {
        // Stop-everything must not depend on registration timing: a
        // child's turn/started can arrive before the subAgentActivity that
        // registers it (captured ordering), and suppressing it without
        // remembering the live turn would leave that child running after
        // Stop (review finding). Track live turns for ANY foreign
        // conversation; interrupts are best-effort per child, so a
        // false-positive entry costs one ignored RPC at worst.
        const foreignThreadId = readNotificationThreadId(notification);

        if (foreignThreadId !== undefined) {
          if (notification.method === "turn/started") {
            const foreignTurnId =
              typeof (notification.params as { turn?: { id?: unknown } }).turn?.id === "string"
                ? (notification.params as { turn: { id: string } }).turn.id
                : undefined;

            if (foreignTurnId) {
              yield* Ref.update(deps.collabChildLiveTurnsRef, (current) => {
                const next = new Map(current);
                next.set(foreignThreadId, foreignTurnId);

                return next;
              });
            }
          } else if (
            notification.method === "turn/completed" ||
            notification.method === "thread/closed"
          ) {
            yield* Ref.update(deps.collabChildLiveTurnsRef, (current) => {
              const next = new Map(current);
              next.delete(foreignThreadId);

              return next;
            });
          }
        }

        yield* Ref.set(deps.collabReceiverTurnsRef, collabReceiverTurns);

        return;
      }

      if (isMemoryConsolidationNotification) {
        return;
      }

      let requestId: ApprovalRequestId | undefined;
      let requestKind: ProviderRequestKind | undefined;
      let turnId = childParentTurnId ?? route.turnId;
      let itemId = route.itemId;

      if (notification.method === "serverRequest/resolved") {
        const rawRequestId =
          typeof notification.params.requestId === "string"
            ? notification.params.requestId
            : String(notification.params.requestId);

        const correlation = rawRequestId
          ? (yield* Ref.get(deps.approvalCorrelationsRef)).get(rawRequestId)
          : undefined;

        if (correlation) {
          requestId = correlation.requestId;
          requestKind = correlation.requestKind;
          turnId = correlation.turnId ?? turnId;
          itemId = correlation.itemId ?? itemId;
          yield* Ref.update(deps.approvalCorrelationsRef, (current) => {
            const next = new Map(current);
            next.delete(rawRequestId);

            return next;
          });
        }
      }

      yield* Ref.set(deps.collabReceiverTurnsRef, collabReceiverTurns);
      yield* deps.emitEvent({
        kind: "notification",
        threadId: deps.options.threadId,
        method: notification.method,
        ...(turnId ? { turnId } : {}),
        ...(itemId ? { itemId } : {}),
        ...(requestId ? { requestId } : {}),
        ...(requestKind ? { requestKind } : {}),
        ...(notification.method === "item/agentMessage/delta"
          ? { textDelta: notification.params.delta }
          : {}),
        ...(payload !== undefined ? { payload } : {}),
      });
    });

  return { interceptCollabChildNotification, handleRawNotification };
}
