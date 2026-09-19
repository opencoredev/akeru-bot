import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  AkeruMemoryDocument,
  AkeruMemoryDocumentTarget,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { BotMemoryTransfer } from "./BotMemoryTransfer";

import { memoryEnvironment } from "../../state/memory";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Sheet, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "../ui/sheet";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";

export function memoryErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Memory request failed.";
}

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]) {
  return memoryErrorMessage(squashAtomCommandFailure(result));
}

const documentCopy: Record<
  AkeruMemoryDocumentTarget,
  { readonly title: string; readonly description: string }
> = {
  user: { title: "USER.md", description: "Stable details this bot has learned about you." },
  memory: {
    title: "MEMORY.md",
    description: "Durable notes and working preferences owned by this bot.",
  },
  group: {
    title: "GROUP.md",
    description: "This bot's private memory for the active group chat.",
  },
};

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
  const copy = documentCopy[document.target];

  return (
    <section className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">{copy.title}</h3>
          <p className="text-xs text-muted-foreground">{copy.description}</p>
        </div>
        <span
          className={
            overLimit
              ? "shrink-0 whitespace-nowrap text-xs text-destructive"
              : "shrink-0 whitespace-nowrap text-xs text-muted-foreground"
          }
        >
          {draft.length.toLocaleString()} / {document.charLimit.toLocaleString()}
        </span>
      </div>
      <Textarea
        aria-label={`Edit ${copy.title}`}
        className="min-h-36 font-mono text-xs"
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
        disabled={busy}
        spellCheck={false}
      />
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || !changed}
          onClick={() => setDraft(document.content)}
        >
          Reset
        </Button>
        <Button
          size="sm"
          disabled={busy || !changed || overLimit}
          onClick={() => void onSave(document.target, draft, document.content)}
        >
          Save
        </Button>
      </div>
    </section>
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
      const message = failureMessage(result);
      setError(message);
      toastManager.add({ type: "error", title: "Could not save memory", description: message });
    }
    return result._tag !== "Failure";
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup className="max-w-2xl" side="right">
        <SheetHeader>
          <SheetTitle>Memory</SheetTitle>
        </SheetHeader>
        <SheetPanel className="space-y-5">
          {!threadRef ? (
            <p className="text-sm text-muted-foreground">Start a conversation to manage memory.</p>
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
            <p className="text-sm text-muted-foreground">Loading memory...</p>
          ) : null}
          {query.data ? (
            <>
              <div
                key={`${threadRef?.environmentId}:${threadRef?.threadId}:${query.data.botId}`}
                className="space-y-3"
                data-testid="memory-documents"
              >
                <MemoryDocumentEditor document={query.data.user} busy={busy} onSave={save} />
                <MemoryDocumentEditor document={query.data.memory} busy={busy} onSave={save} />
                {query.data.group ? (
                  <MemoryDocumentEditor document={query.data.group} busy={busy} onSave={save} />
                ) : null}
              </div>

              <section className="space-y-3 rounded-lg border border-border p-3">
                <div>
                  <h3 className="text-sm font-medium">Observational memory</h3>
                  <p className="text-xs text-muted-foreground">
                    Automatic summaries of this chat. These stay separate from the Markdown files.
                  </p>
                </div>
                {query.data.conversation.current ? (
                  <div className="space-y-2 text-sm">
                    <p className="text-xs text-muted-foreground">
                      {query.data.conversation.current.generationCount.toLocaleString()} generations
                    </p>
                    <p className="whitespace-pre-wrap">
                      {query.data.conversation.current.activeObservations}
                    </p>
                    {previousObservations.length > 0 ? (
                      <details>
                        <summary className="cursor-pointer text-xs text-muted-foreground">
                          Previous observations ({previousObservations.length})
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
                  <p className="text-sm text-muted-foreground">No observations yet.</p>
                )}
                <Button
                  size="sm"
                  variant={clearPending ? "destructive" : "outline"}
                  disabled={busy || !query.data.conversation.current}
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
                          title: "Could not save memory",
                          description: message,
                        });
                      } else setClearPending(false);
                    });
                  }}
                >
                  {clearPending ? "Clear observations" : "Clear"}
                </Button>
              </section>
              {threadRef ? (
                <BotMemoryTransfer
                  key={`${threadRef.environmentId}:${threadRef.threadId}`}
                  threadRef={threadRef}
                />
              ) : null}
            </>
          ) : null}
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
}
