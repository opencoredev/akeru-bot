import { createTranslator } from "@akeru/client-runtime/i18n";
import { withoutErrorStack } from "@akeru/shared/errorText";
import type { Routine, RoutineReceiptSource, RoutineRun, ThreadId } from "@akeru/contracts";
import type { BotConversationEntry } from "./botConversationPresentation";

export interface RoutineReceipt {
  readonly id: string;
  readonly createdAt: string;
  readonly text: string;
  readonly tone: "info" | "success" | "error";
  readonly archived?: true;
}

export function mergeBotConversationTimeline(
  entries: ReadonlyArray<BotConversationEntry>,
  receipts: ReadonlyArray<RoutineReceipt>,
) {
  const sorted = [
    ...entries.map((entry, index) => ({
      kind: "message" as const,
      createdAt: entry.message.createdAt,
      entry,
      index,
    })),
    ...receipts.map((receipt) => ({
      kind: "receipt" as const,
      createdAt: receipt.createdAt,
      receipt,
    })),
  ].toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));

  return sorted.map((item, index) =>
    item.kind === "message" && sorted[index - 1]?.kind === "receipt"
      ? { ...item, entry: { ...item.entry, startsGroup: true } }
      : item,
  );
}
type ReceiptTranslator = Pick<ReturnType<typeof createTranslator>, "t">;

export function mergeRoutineRunHistory(
  history: ReadonlyArray<RoutineRun>,
  recent: ReadonlyArray<RoutineRun>,
): RoutineRun[] {
  return [...new Map([...history, ...recent].map((run) => [run.id, run])).values()];
}

const englishTranslator: ReceiptTranslator = createTranslator("en");

/** Routine and run text stay as written; only the sentence around them is translated. */
export function deriveRoutineReceipts(
  threadId: ThreadId,
  routines: ReadonlyArray<Routine | RoutineReceiptSource>,
  runs: ReadonlyArray<RoutineRun>,
  { t }: ReceiptTranslator = englishTranslator,
): RoutineReceipt[] {
  const withDetail = (summary: string, detail: string | undefined) => {
    const trimmed = detail?.trim();
    return trimmed ? t("{summary}: {detail}", { summary, detail: trimmed }) : summary;
  };
  const threadRoutines = routines.filter((routine) => routine.targetThreadId === threadId);
  const byRoutineId = new Map(threadRoutines.map((routine) => [routine.id, routine]));
  const receipts: RoutineReceipt[] = [];

  for (const routine of threadRoutines) {
    const archived = !("deletedAt" in routine) || routine.deletedAt !== null;
    receipts.push({
      id: `routine-created:${routine.id}`,
      createdAt: routine.createdAt,
      text: t("Routine “{name}” was created", { name: routine.job }),
      tone: "info",
      ...(archived ? { archived: true } : {}),
    });
  }

  for (const run of runs) {
    const routine = byRoutineId.get(run.routineId);
    if (!routine) continue;
    const archived = !("deletedAt" in routine) || routine.deletedAt !== null;
    if (run.startedAt !== null) {
      receipts.push({
        id: `routine-run-started:${run.id}`,
        createdAt: run.startedAt,
        text: t("“{name}” started a run", { name: routine.job }),
        tone: "info",
        ...(archived ? { archived: true } : {}),
      });
    }
    switch (run.status) {
      case "queued":
      case "waiting-for-approval":
        // Not started yet; the panel shows pending runs, the chat waits for real work.
        break;
      case "running":
        break;
      case "canceled":
        receipts.push({
          id: `routine-run-finished:${run.id}`,
          createdAt: run.completedAt ?? run.updatedAt,
          text: t("“{name}” was canceled", { name: routine.job }),
          tone: "info",
          ...(archived ? { archived: true } : {}),
        });
        break;
      case "failed":
      case "blocked":
        receipts.push({
          id: `routine-run-finished:${run.id}`,
          createdAt: run.completedAt ?? run.updatedAt,
          text: withDetail(
            t("“{name}” failed", { name: routine.job }),
            run.failure ? withoutErrorStack(run.failure.message) : undefined,
          ),
          tone: "error",
          ...(archived ? { archived: true } : {}),
        });
        break;
      case "completed":
        receipts.push({
          id: `routine-run-finished:${run.id}`,
          createdAt: run.completedAt ?? run.updatedAt,
          text: withDetail(t("“{name}” finished", { name: routine.job }), run.result?.summary),
          tone: "success",
          ...(archived ? { archived: true } : {}),
        });
        break;
    }
  }

  return receipts.toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
}

/**
 * A receipt's text for a label that appends its own sentence break, such as
 * "{text}. Open Routines", so text that already ends a sentence is not doubled.
 */
export function routineReceiptLabelText(text: string): string {
  return text.trimEnd().replace(/[.!?。！？]+$/u, "");
}
