import { threadDelegations } from "@akeru/client-runtime/delegation-presentation";
import { botChatTimeline } from "@akeru/client-runtime/state/bot-chat-timeline";
import type {
  OrchestrationShellSnapshot,
  RoutineRun,
  RoutineRunId,
  ScopedThreadRef,
} from "@akeru/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { useI18n } from "../../i18n";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import type { BotConversationEntry } from "./botConversationPresentation";
import { deriveRoutineReceipts, mergeRoutineRunHistory } from "./routineReceipts";

/**
 * Merges a bot chat's messages, routine run notes, and delegations into one ordered
 * timeline. Routine run history pages in older notes on request and refreshes when the
 * snapshot shows a run for this chat changed.
 */
export function useBotLandingTimeline(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly snapshot: OrchestrationShellSnapshot | null;
  readonly entries: ReadonlyArray<BotConversationEntry>;
}) {
  const { entries, snapshot, threadRef } = input;
  const { t } = useI18n();

  const routineRunHistory = useEnvironmentQuery(
    threadRef
      ? serverEnvironment.routineThreadRuns({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        })
      : null,
  );

  const threadId = threadRef?.threadId ?? null;

  const [routineHistory, setRoutineHistory] = useState<{
    threadId: string | null;
    runs: RoutineRun[];
    requestedCursor: RoutineRunId | null;
    loadedCursor: RoutineRunId | null;
    nextCursor: RoutineRunId | null;
  }>({ threadId: null, runs: [], requestedCursor: null, loadedCursor: null, nextCursor: null });

  const currentHistory =
    routineHistory.threadId === threadId
      ? routineHistory
      : { threadId, runs: [], requestedCursor: null, loadedCursor: null, nextCursor: null };

  const olderRoutineRuns = useEnvironmentQuery(
    threadRef && currentHistory.requestedCursor
      ? serverEnvironment.routineThreadRuns({
          environmentId: threadRef.environmentId,
          input: {
            threadId: threadRef.threadId,
            beforeRunId: currentHistory.requestedCursor,
          },
        })
      : null,
  );

  useEffect(() => {
    setRoutineHistory({
      threadId,
      runs: [],
      requestedCursor: null,
      loadedCursor: null,
      nextCursor: null,
    });
  }, [threadId]);
  useEffect(() => {
    const page = routineRunHistory.data;

    if (!page || !threadId) return;
    setRoutineHistory((previous) =>
      previous.threadId === threadId
        ? {
            ...previous,
            runs: mergeRoutineRunHistory(previous.runs, page.runs),
            nextCursor: previous.loadedCursor === null ? page.nextCursor : previous.nextCursor,
          }
        : previous,
    );
  }, [routineRunHistory.data, threadId]);
  useEffect(() => {
    const page = olderRoutineRuns.data;
    const cursor = currentHistory.requestedCursor;

    if (!page || !cursor || currentHistory.loadedCursor === cursor) return;
    setRoutineHistory((previous) =>
      previous.threadId === threadId && previous.requestedCursor === cursor
        ? {
            ...previous,
            runs: mergeRoutineRunHistory(previous.runs, page.runs),
            loadedCursor: cursor,
            nextCursor: page.nextCursor,
          }
        : previous,
    );
  }, [
    currentHistory.loadedCursor,
    currentHistory.requestedCursor,
    olderRoutineRuns.data,
    threadId,
  ]);

  const nextRoutineCursor =
    currentHistory.loadedCursor === null
      ? (routineRunHistory.data?.nextCursor ?? null)
      : currentHistory.nextCursor;

  const routineRunRevision = useMemo(() => {
    const threadId = threadRef?.threadId;

    if (!threadId) return null;

    const routineIds = [...(snapshot?.routines ?? []), ...(snapshot?.routineReceiptSources ?? [])]
      .filter((routine) => routine.targetThreadId === threadId)
      .map((routine) => routine.id)
      .toSorted();

    const relevantIds = new Set(routineIds);

    const runs = (snapshot?.routineRuns ?? [])
      .filter((run) => relevantIds.has(run.routineId))
      .map((run) => [run.id, run.updatedAt] as const)
      .toSorted(([left], [right]) => left.localeCompare(right));

    return JSON.stringify([routineIds, runs]);
  }, [
    threadRef?.threadId,
    snapshot?.routines,
    snapshot?.routineReceiptSources,
    snapshot?.routineRuns,
  ]);

  const observedRoutineRevision = useRef<{
    threadId: string | null;
    revision: string | null;
  }>({ threadId: null, revision: null });

  useEffect(() => {
    const threadId = threadRef?.threadId ?? null;
    const previous = observedRoutineRevision.current;
    observedRoutineRevision.current = { threadId, revision: routineRunRevision };

    if (threadId === previous.threadId && routineRunRevision !== previous.revision) {
      routineRunHistory.refresh();
    }
  }, [threadRef?.threadId, routineRunRevision, routineRunHistory.refresh]);

  const routineReceipts = useMemo(
    () =>
      threadRef
        ? deriveRoutineReceipts(
            threadRef.threadId,
            [...(snapshot?.routines ?? []), ...(snapshot?.routineReceiptSources ?? [])],
            mergeRoutineRunHistory(currentHistory.runs, snapshot?.routineRuns ?? []),
            { t },
          )
        : [],
    [
      threadRef,
      snapshot?.routines,
      snapshot?.routineReceiptSources,
      snapshot?.routineRuns,
      currentHistory.runs,
      t,
    ],
  );

  const { delegations, waitingOnChildren } = useMemo(
    () =>
      threadRef && snapshot
        ? threadDelegations(snapshot.delegations, threadRef.threadId)
        : { delegations: [], waitingOnChildren: false },
    [threadRef, snapshot],
  );

  // Each message row carries the index it had in `messages`, because the merge
  // reorders it away from that position and a row must not go looking for itself.
  const timelineItems = useMemo(
    () =>
      botChatTimeline({
        messages: entries.map((entry) => ({
          id: entry.message.id,
          turnId: entry.message.turnId,
          createdAt: entry.message.createdAt,
          entry,
        })),
        receipts: routineReceipts,
        delegations,
      }),
    [entries, routineReceipts, delegations],
  );

  const loadOlderRoutineNotes = () => {
    if (currentHistory.requestedCursor === nextRoutineCursor) {
      olderRoutineRuns.refresh();
    } else {
      setRoutineHistory((previous) => ({
        ...previous,
        requestedCursor: nextRoutineCursor,
      }));
    }
  };

  return {
    timelineItems,
    delegations,
    waitingOnChildren,
    olderRoutineNotes: {
      nextCursor: nextRoutineCursor,
      isPending: olderRoutineRuns.isPending,
      error: olderRoutineRuns.error,
      load: loadOlderRoutineNotes,
    },
  };
}
