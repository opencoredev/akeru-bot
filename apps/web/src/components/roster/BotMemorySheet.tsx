import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AkeruMemoryArchiveV2,
  type AkeruMemoryCandidate,
  type AkeruMemoryImportPreview,
  type AkeruMemoryRevision,
  type AkeruMemoryTargetScope,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { memoryEnvironment } from "../../state/memory";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Sheet, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "../ui/sheet";
import { Textarea } from "../ui/textarea";

const SCOPES: readonly AkeruMemoryTargetScope[] = [
  "private",
  "bot",
  "project",
  "group",
  "workspace",
];
const decodeMemoryArchive = Schema.decodeUnknownEffect(AkeruMemoryArchiveV2);

type ImportState = {
  readonly archive: AkeruMemoryArchiveV2;
  readonly preview: AkeruMemoryImportPreview;
};

export function factEditInput(
  threadRef: ScopedThreadRef,
  memory: AkeruMemoryRevision,
  fact: string,
) {
  return {
    environmentId: threadRef.environmentId,
    input: {
      threadId: threadRef.threadId,
      mutation: {
        operation: "fact.edit" as const,
        memoryId: memory.rootId,
        expectedRevision: memory.revision,
        fact: fact.trim(),
      },
    },
  };
}

export function factDeleteInput(threadRef: ScopedThreadRef, memory: AkeruMemoryRevision) {
  return {
    environmentId: threadRef.environmentId,
    input: {
      threadId: threadRef.threadId,
      mutation: {
        operation: "fact.delete" as const,
        memoryId: memory.rootId,
        expectedRevision: memory.revision,
      },
    },
  };
}

export function candidateDecisionInput(
  threadRef: ScopedThreadRef,
  candidate: AkeruMemoryCandidate,
  decision: "approve" | "reject",
  fact = candidate.fact,
  scope = candidate.scope,
) {
  return {
    environmentId: threadRef.environmentId,
    input: {
      threadId: threadRef.threadId,
      mutation: {
        operation: "candidate.decide" as const,
        decision:
          decision === "approve"
            ? { candidateId: candidate.candidateId, decision, fact: fact.trim(), scope }
            : { candidateId: candidate.candidateId, decision },
      },
    },
  };
}

export function importApplyInput(threadRef: ScopedThreadRef, state: ImportState) {
  return {
    environmentId: threadRef.environmentId,
    input: {
      threadId: threadRef.threadId,
      target: "thread" as const,
      archive: state.archive,
      previewHash: state.preview.previewHash,
    },
  };
}

export function memoryErrorMessage(error: unknown) {
  return error instanceof Error && error.message.trim() ? error.message : "Memory request failed.";
}

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]) {
  return memoryErrorMessage(squashAtomCommandFailure(result));
}

function downloadArchive(archive: AkeruMemoryArchiveV2) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(archive, null, 2)], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `akeru-memory-${archive.anchorThreadId}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function MemoryFact({
  memory,
  history,
  busy,
  onEdit,
  onDelete,
}: {
  readonly memory: AkeruMemoryRevision;
  readonly history: readonly AkeruMemoryRevision[];
  readonly busy: boolean;
  readonly onEdit: (fact: string) => void;
  readonly onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [fact, setFact] = useState(memory.fact);
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <article className="rounded-lg border border-border p-3" data-testid="memory-fact">
      {editing ? (
        <div className="space-y-2">
          <Textarea
            aria-label="Memory fact"
            value={fact}
            rows={3}
            onChange={(event) => setFact(event.currentTarget.value)}
          />
          <div className="flex justify-end gap-2">
            <Button size="xs" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="xs" disabled={busy || !fact.trim()} onClick={() => onEdit(fact)}>
              Save
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p className="whitespace-pre-wrap text-sm leading-5">{memory.fact}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge variant="outline">{memory.partition.scope}</Badge>
            <span className="text-xs text-muted-foreground">Revision {memory.revision}</span>
            {memory.pinned ? <Badge variant="secondary">Pinned</Badge> : null}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Button size="xs" variant="outline" disabled={busy} onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button
              size="xs"
              variant={confirmDelete ? "destructive" : "ghost"}
              disabled={busy}
              onClick={() => (confirmDelete ? onDelete() : setConfirmDelete(true))}
            >
              {confirmDelete ? "Delete memory" : "Delete"}
            </Button>
          </div>
        </>
      )}
      {history.length > 1 ? (
        <details className="mt-3 border-t border-border pt-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            {history.length} revisions
          </summary>
          <ol className="mt-2 space-y-2">
            {history.toReversed().map((revision) => (
              <li key={revision.id}>
                <span className="font-medium">Revision {revision.revision}</span>
                <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">{revision.fact}</p>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </article>
  );
}

function PendingMemory({
  candidate,
  busy,
  onDecide,
}: {
  readonly candidate: AkeruMemoryCandidate;
  readonly busy: boolean;
  readonly onDecide: (
    decision: "approve" | "reject",
    fact: string,
    scope: AkeruMemoryTargetScope,
  ) => void;
}) {
  const [fact, setFact] = useState(candidate.fact);
  const [scope, setScope] = useState(candidate.scope);
  return (
    <article
      className="space-y-2 rounded-lg border border-warning/40 bg-warning/5 p-3"
      data-testid="pending-memory"
    >
      <Textarea
        aria-label="Pending memory fact"
        value={fact}
        rows={3}
        onChange={(event) => setFact(event.currentTarget.value)}
      />
      <Select
        value={scope}
        onValueChange={(value) => value && setScope(value as AkeruMemoryTargetScope)}
      >
        <SelectTrigger aria-label="Pending memory scope">
          <SelectValue>{scope}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {SCOPES.map((value) => (
            <SelectItem key={value} value={value}>
              {value}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <div className="flex justify-end gap-2">
        <Button
          size="xs"
          variant="ghost"
          disabled={busy}
          onClick={() => onDecide("reject", fact, scope)}
        >
          Reject
        </Button>
        <Button
          size="xs"
          disabled={busy || !fact.trim()}
          onClick={() => onDecide("approve", fact, scope)}
        >
          Approve
        </Button>
      </div>
    </article>
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
    threadRef
      ? memoryEnvironment.inspect({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        })
      : null,
  );
  const mutate = useAtomCommand(memoryEnvironment.mutate, { reportFailure: false });
  const exportArchive = useAtomCommand(memoryEnvironment.exportArchive, { reportFailure: false });
  const previewImport = useAtomCommand(memoryEnvironment.previewImport, { reportFailure: false });
  const applyImport = useAtomCommand(memoryEnvironment.applyImport, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importState, setImportState] = useState<ImportState | null>(null);
  const [clearPending, setClearPending] = useState(false);

  const runMutation = async (input: Parameters<typeof mutate>[0]) => {
    setBusy(true);
    setError(null);
    const result = await mutate(input);
    setBusy(false);
    if (result._tag === "Failure") setError(failureMessage(result));
    return result._tag !== "Failure";
  };

  if (!threadRef) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetPopup className="max-w-2xl" side="right">
          <SheetHeader>
            <SheetTitle>Memory</SheetTitle>
          </SheetHeader>
          <SheetPanel>
            <p className="text-sm text-muted-foreground">Start a conversation to manage memory.</p>
          </SheetPanel>
        </SheetPopup>
      </Sheet>
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup className="max-w-2xl" side="right">
        <SheetHeader>
          <SheetTitle>Memory</SheetTitle>
        </SheetHeader>
        <SheetPanel className="space-y-6">
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
              <section className="space-y-3">
                <h3 className="text-sm font-medium">Facts</h3>
                {query.data.durable.length ? (
                  query.data.durable.map((memory) => (
                    <MemoryFact
                      key={memory.rootId}
                      memory={memory}
                      history={
                        query.data?.histories.find((item) => item.rootId === memory.rootId)
                          ?.revisions ?? [memory]
                      }
                      busy={busy}
                      onEdit={(fact) => void runMutation(factEditInput(threadRef, memory, fact))}
                      onDelete={() => void runMutation(factDeleteInput(threadRef, memory))}
                    />
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">No saved facts.</p>
                )}
              </section>

              {query.data.pending.length ? (
                <section className="space-y-3">
                  <h3 className="text-sm font-medium">Pending</h3>
                  {query.data.pending.map((candidate) => (
                    <PendingMemory
                      key={candidate.candidateId}
                      candidate={candidate}
                      busy={busy}
                      onDecide={(decision, fact, scope) =>
                        void runMutation(
                          candidateDecisionInput(threadRef, candidate, decision, fact, scope),
                        )
                      }
                    />
                  ))}
                </section>
              ) : null}

              <section className="space-y-3">
                <h3 className="text-sm font-medium">Conversation</h3>
                <p className="text-sm text-muted-foreground">
                  {query.data.conversation.current
                    ? `${query.data.conversation.current.generationCount} generations`
                    : "No conversation memory."}
                </p>
                <Button
                  size="sm"
                  variant={clearPending ? "destructive" : "outline"}
                  disabled={busy || !query.data.conversation.current}
                  onClick={() => {
                    if (!clearPending) return setClearPending(true);
                    void runMutation({
                      environmentId: threadRef.environmentId,
                      input: {
                        threadId: threadRef.threadId,
                        mutation: { operation: "conversation.clear" },
                      },
                    }).then((success) => success && setClearPending(false));
                  }}
                >
                  {clearPending ? "Clear conversation memory" : "Clear"}
                </Button>
              </section>

              <section className="space-y-3">
                <h3 className="text-sm font-medium">Transfer</h3>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      setError(null);
                      void exportArchive({
                        environmentId: threadRef.environmentId,
                        input: { threadId: threadRef.threadId, complete: true, target: "thread" },
                      }).then((result) => {
                        setBusy(false);
                        if (result._tag === "Failure") setError(failureMessage(result));
                        else downloadArchive(result.value);
                      });
                    }}
                  >
                    Export thread
                  </Button>
                  <label className="inline-flex">
                    <Input
                      className="sr-only"
                      aria-label="Import memory archive"
                      type="file"
                      accept="application/json,.json"
                      disabled={busy}
                      onChange={(event) => {
                        const file = event.currentTarget.files?.[0];
                        if (!file) return;
                        setBusy(true);
                        setError(null);
                        setImportState(null);
                        void file
                          .text()
                          .then(JSON.parse)
                          .then((value) => Effect.runPromise(decodeMemoryArchive(value)))
                          .then((archive) =>
                            previewImport({
                              environmentId: threadRef.environmentId,
                              input: { threadId: threadRef.threadId, target: "thread", archive },
                            }).then((result) => {
                              setBusy(false);
                              if (result._tag === "Failure") setError(failureMessage(result));
                              else setImportState({ archive, preview: result.value });
                            }),
                          )
                          .catch((cause: unknown) => {
                            setBusy(false);
                            setError(
                              cause instanceof Error ? cause.message : "Invalid memory archive.",
                            );
                          });
                      }}
                    />
                    <span className="inline-flex h-8 cursor-pointer items-center rounded-lg border border-input px-3 text-sm">
                      Preview import
                    </span>
                  </label>
                </div>
                {importState ? (
                  <div
                    className="rounded-lg border border-border p-3"
                    data-testid="memory-import-preview"
                  >
                    <ul className="space-y-1 text-sm">
                      {importState.preview.items.map((item) => (
                        <li key={item.rootId}>
                          <span className="font-medium">{item.classification}</span> {item.reason}
                        </li>
                      ))}
                    </ul>
                    <Button
                      className="mt-3"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setBusy(true);
                        setError(null);
                        void applyImport(importApplyInput(threadRef, importState)).then(
                          (result) => {
                            setBusy(false);
                            if (result._tag === "Failure") setError(failureMessage(result));
                            else setImportState(null);
                          },
                        );
                      }}
                    >
                      Apply import
                    </Button>
                  </div>
                ) : null}
              </section>
            </>
          ) : null}
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
}
