import type { MessageKey } from "@akeru/client-runtime/i18n";
import { squashAtomCommandFailure } from "@akeru/client-runtime/state/runtime";
import type {
  AkeruMemoryDocument,
  AkeruMemoryDocumentTarget,
  ScopedThreadRef,
} from "@akeru/contracts";
import { BrainIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { BotDurableMemory } from "./BotDurableMemory";
import { memoryDocumentCopy } from "./botMemoryCopy";
import { BotMemoryTransfer } from "./BotMemoryTransfer";
import { BotSideSheet, BotSideSheetEmpty, BotSideSheetSection } from "./BotSideSheet";

import { useI18n } from "../../i18n";
import { memoryEnvironment } from "../../state/memory";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";

/** The server's own error text, shown as received, or null when it sent none. */
export function memoryErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : null;
}

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]) {
  return memoryErrorMessage(squashAtomCommandFailure(result));
}

function MemoryDocumentEditor({
  document,
  busy,
  onSave,
}: {
  readonly document: AkeruMemoryDocument;
  readonly busy: boolean;
  readonly onSave: (
    target: AkeruMemoryDocumentTarget,
    content: string,
    expectedContent: string,
  ) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(document.content);
  useEffect(() => setDraft(document.content), [document.content, document.updatedAt]);
  const changed = draft !== document.content;
  const overLimit = draft.length > document.charLimit;
  const copy = memoryDocumentCopy[document.target];
  const { t, formatNumber } = useI18n();

  return (
    <BotSideSheetSection
      title={t(copy.title)}
      description={t(copy.description)}
      action={
        <span
          className={
            overLimit
              ? "whitespace-nowrap text-xs tabular-nums text-destructive"
              : "whitespace-nowrap text-xs tabular-nums text-muted-foreground"
          }
          aria-label={t("{used} of {limit} characters used", {
            used: formatNumber(draft.length),
            limit: formatNumber(document.charLimit),
          })}
        >
          {formatNumber(draft.length)} / {formatNumber(document.charLimit)}
        </span>
      }
    >
      <Textarea
        aria-label={t("Edit {name}", { name: t(copy.title) })}
        className="min-h-32"
        placeholder={t("Nothing saved yet. Add a note in plain text or Markdown.")}
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
        disabled={busy}
      />
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || !changed}
          onClick={() => setDraft(document.content)}
        >
          {t("Reset")}
        </Button>
        <Button
          size="sm"
          disabled={busy || !changed || overLimit}
          onClick={() => void onSave(document.target, draft, document.content)}
        >
          {t("Save")}
        </Button>
      </div>
    </BotSideSheetSection>
  );
}

export function BotMemorySheet({
  open,
  onOpenChange,
  threadRef,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly threadRef: ScopedThreadRef | null;
}) {
  const { t, plural, formatNumber } = useI18n();
  const query = useEnvironmentQuery(
    open && threadRef
      ? memoryEnvironment.inspectDocuments({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        })
      : null,
  );
  const replaceDocument = useAtomCommand(memoryEnvironment.replaceDocument, {
    reportFailure: false,
  });
  const clearObservations = useAtomCommand(memoryEnvironment.clearObservations, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clearPending, setClearPending] = useState(false);
  const previousObservations = query.data?.conversation.current
    ? query.data.conversation.history.filter(
        (item) => item.generationCount !== query.data!.conversation.current!.generationCount,
      )
    : [];

  const save = async (
    target: AkeruMemoryDocumentTarget,
    content: string,
    expectedContent: string,
  ) => {
    if (!threadRef || !query.data) return false;
    setBusy(true);
    setError(null);
    const result = await replaceDocument({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        expectedBotId: query.data.botId,
        expectedContent,
        target,
        content,
      },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      const message = failureMessage(result) ?? t("Memory request failed.");
      setError(message);
      toastManager.add({ type: "error", title: t("Could not save memory"), description: message });
    }
    return result._tag !== "Failure";
  };

  const current = query.data?.conversation.current ?? null;
  const summary = current?.activeObservations.trim() ?? "";

  return (
    <BotSideSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("Memory")}
      description={t(
        "What this bot remembers between chats. Edit anything that is wrong or out of date.",
      )}
    >
      {!threadRef ? (
        <BotSideSheetEmpty
          icon={BrainIcon}
          title={t("No memory yet")}
          description={t("Start a chat with this bot to see and edit what it remembers.")}
        />
      ) : null}
      {(error ?? query.error) ? (
        <div
          role="alert"
          className="rounded-lg bg-destructive/8 p-3 text-sm text-destructive-foreground"
        >
          {error ?? query.error}
        </div>
      ) : null}
      {query.isPending && !query.data ? (
        <div className="flex justify-center py-12">
          <Spinner aria-label={t("Loading memory…")} />
        </div>
      ) : null}
      {query.data ? (
        <>
          <div
            key={`${threadRef?.environmentId}:${threadRef?.threadId}:${query.data.botId}`}
            className="space-y-6"
            data-testid="memory-documents"
          >
            <MemoryDocumentEditor document={query.data.user} busy={busy} onSave={save} />
            <MemoryDocumentEditor document={query.data.memory} busy={busy} onSave={save} />
            {query.data.group ? (
              <MemoryDocumentEditor document={query.data.group} busy={busy} onSave={save} />
            ) : null}
          </div>

          <BotSideSheetSection
            className="border-t pt-6"
            title={t("Chat summary")}
            description={t(
              "Notes the bot writes on its own as this chat grows, so it can recall earlier parts of a long conversation. They only apply to this chat.",
            )}
            action={
              <Button
                size="sm"
                variant={clearPending ? "destructive" : "outline"}
                disabled={busy || !current}
                onClick={() => {
                  if (!clearPending) return setClearPending(true);
                  if (!threadRef) return;
                  setBusy(true);
                  setError(null);
                  void clearObservations({
                    environmentId: threadRef.environmentId,
                    input: { threadId: threadRef.threadId },
                  }).then((result) => {
                    setBusy(false);
                    if (result._tag === "Failure") {
                      const message = failureMessage(result);
                      setError(message);
                      toastManager.add({
                        type: "error",
                        title: t("Could not clear the chat summary"),
                        description: message,
                      });
                    } else setClearPending(false);
                  });
                }}
              >
                {clearPending ? t("Confirm clear") : t("Clear summary")}
              </Button>
            }
          >
            {current && summary.length > 0 ? (
              <div className="space-y-3 text-sm">
                <p className="whitespace-pre-wrap rounded-lg bg-secondary px-3 py-2">{summary}</p>
                {current.generationCount > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {plural(current.generationCount, {
                      one: "Condensed {count} time to stay short.",
                      other: "Condensed {count} times to stay short.",
                    })}
                  </p>
                ) : null}
                {previousObservations.length > 0 ? (
                  <details>
                    <summary className="cursor-pointer text-xs text-muted-foreground">
                      {t("Earlier summaries ({count})", {
                        count: formatNumber(previousObservations.length),
                      })}
                    </summary>
                    <div className="mt-2 space-y-3">
                      {previousObservations.map((item) => (
                        <p
                          className="whitespace-pre-wrap text-xs text-muted-foreground"
                          key={`${item.generationCount}-${item.updatedAt}`}
                        >
                          {item.activeObservations}
                        </p>
                      ))}
                    </div>
                  </details>
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("Nothing yet. The bot starts a summary once the chat gets long.")}
              </p>
            )}
          </BotSideSheetSection>
          {threadRef ? (
            <BotDurableMemory
              key={`durable:${threadRef.environmentId}:${threadRef.threadId}`}
              threadRef={threadRef}
              botId={query.data.botId}
            />
          ) : null}
          {threadRef ? (
            <BotMemoryTransfer
              key={`${threadRef.environmentId}:${threadRef.threadId}`}
              threadRef={threadRef}
            />
          ) : null}
        </>
      ) : null}
    </BotSideSheet>
  );
}
