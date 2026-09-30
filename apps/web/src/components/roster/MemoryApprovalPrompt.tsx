import {
  canSaveDurableFactEdit,
  describeDurableFactFailure,
  durableFactBotsLabel,
  memoryApprovalHeading,
  memoryApprovalMutation,
  type MemoryApprovalIntent,
} from "@t3tools/client-runtime/durable-memory";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AkeruMemoryApprovalRequest, ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useMemo, useState } from "react";

import { useI18n } from "../../i18n";
import { environmentBotsAtom } from "../../state/bots";
import { memoryEnvironment } from "../../state/memory";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

// Asks the user to approve a shared fact a bot wants to save. Shown above the
// composer while the chat has undecided requests; the inbox resolves the same ones.
export function MemoryApprovalPrompt({
  threadRef,
  approvals,
  currentBotId,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly approvals: ReadonlyArray<AkeruMemoryApprovalRequest>;
  readonly currentBotId: string | null;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const approval = approvals[0];
  const bots = useAtomValue(environmentBotsAtom(threadRef.environmentId));
  const botNames = useMemo(() => new Map(bots.map((bot) => [bot.id as string, bot.name])), [bots]);
  const mutateFact = useAtomCommand(memoryEnvironment.mutateFact, { reportFailure: false });
  const [draft, setDraft] = useState<{
    readonly candidateId: string;
    readonly fact: string;
  } | null>(null);
  const [responding, setResponding] = useState(false);
  const [failure, setFailure] = useState<{
    readonly candidateId: string;
    readonly message: string;
  } | null>(null);
  if (!approval) return null;

  const editing = draft?.candidateId === approval.candidateId ? draft : null;
  const error = failure?.candidateId === approval.candidateId ? failure.message : null;
  const sharedWith = durableFactBotsLabel(approval, { currentBotId, botNames }, i18n);
  const authorName = approval.authorBotId ? botNames.get(approval.authorBotId) : undefined;

  const respond = async (intent: MemoryApprovalIntent) => {
    setResponding(true);
    setFailure(null);
    try {
      const result = await mutateFact({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, mutation: memoryApprovalMutation(approval, intent) },
      });
      if (result._tag === "Failure") {
        setFailure({
          candidateId: approval.candidateId,
          message: t(describeDurableFactFailure(squashAtomCommandFailure(result)).message),
        });
        return;
      }
      setDraft(null);
    } finally {
      setResponding(false);
    }
  };

  return (
    <section
      aria-label={t("Memory approval")}
      className="mb-1 w-full rounded-t-[1.65rem] rounded-b-md border border-white/10 border-b-transparent bg-foreground/[0.12] px-3.5 pt-3 pb-2.5 dark:bg-white/[0.16]"
      data-testid="memory-approval-prompt"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-amber-400" />
        <p className="text-sm font-semibold text-foreground">
          {memoryApprovalHeading(approval.scope, i18n)}
        </p>
        {approval.sensitive ? (
          <span className="text-xs text-muted-foreground">
            {t("Sensitive, always needs approval")}
          </span>
        ) : null}
        {approvals.length > 1 ? (
          <span className="ml-auto text-[11px] font-medium text-muted-foreground tabular-nums">
            {t("1 of {count}", { count: approvals.length })}
          </span>
        ) : null}
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {authorName
          ? t("{botName} wants to save this", { botName: authorName })
          : t("A bot wants to save this")}
      </p>
      {editing ? (
        <Textarea
          aria-label={t("Fact to save")}
          className="mt-2"
          size="sm"
          value={editing.fact}
          disabled={responding}
          onChange={(event) =>
            setDraft({ candidateId: approval.candidateId, fact: event.target.value })
          }
          onKeyDown={(event) => {
            // Escape cancels the edit like the Cancel button; an IME keeps its own Escape.
            if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            event.stopPropagation();
            setDraft(null);
          }}
        />
      ) : (
        <p className="mt-2 text-sm whitespace-pre-wrap text-foreground">{approval.fact}</p>
      )}
      {sharedWith ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {t("Available to {bots}", { bots: sharedWith })}
        </p>
      ) : null}
      <div className="mt-2.5 flex flex-wrap items-center justify-end gap-1.5">
        {editing ? (
          <>
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={responding}
              onClick={() => setDraft(null)}
            >
              {t("Cancel")}
            </Button>
            <Button
              size="xs"
              disabled={responding || !canSaveDurableFactEdit(approval, editing.fact)}
              onClick={() => void respond({ action: "approve", fact: editing.fact })}
            >
              {t("Approve edit")}
            </Button>
          </>
        ) : (
          <>
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={responding}
              onClick={() => void respond({ action: "reject" })}
            >
              {t("Reject")}
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={responding}
              onClick={() => setDraft({ candidateId: approval.candidateId, fact: approval.fact })}
            >
              {t("Edit")}
            </Button>
            <Button
              size="xs"
              disabled={responding}
              onClick={() => void respond({ action: "approve" })}
            >
              {t("Approve")}
            </Button>
          </>
        )}
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
