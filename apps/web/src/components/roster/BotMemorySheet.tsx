import type {
  AkeruMemoryCandidate,
  AkeruMemoryMutation,
  AkeruMemoryRevision,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useMemo, useState } from "react";

import { memoryEnvironment } from "../../state/memory";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { toastManager } from "../ui/toast";

function PendingMemory({
  candidate,
  disabled,
  decide,
}: {
  readonly candidate: AkeruMemoryCandidate;
  readonly disabled: boolean;
  readonly decide: (decision: "approve" | "reject") => void;
}) {
  return (
    <li className="rounded-lg border border-border px-3 py-3">
      <p className="text-sm leading-5">{candidate.fact}</p>
      <div className="mt-3 flex gap-2">
        <Button size="sm" disabled={disabled} onClick={() => decide("approve")}>
          Approve
        </Button>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => decide("reject")}>
          Reject
        </Button>
      </div>
    </li>
  );
}

function DurableMemory({
  revision,
  disabled,
  mutate,
}: {
  readonly revision: AkeruMemoryRevision;
  readonly disabled: boolean;
  readonly mutate: (mutation: AkeruMemoryMutation) => void;
}) {
  return (
    <li className="rounded-lg border border-border px-3 py-3">
      <p className="text-sm leading-5">{revision.fact}</p>
      <p className="mt-1 text-xs capitalize text-muted-foreground">
        {revision.partition.scope === "bot-user" ? "Private" : revision.partition.scope}
      </p>
      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => {
            const fact = window.prompt("Edit memory", revision.fact)?.trim();
            if (!fact || fact === revision.fact) return;
            mutate({
              operation: "fact.edit",
              memoryId: revision.rootId,
              expectedRevision: revision.revision,
              fact,
            });
          }}
        >
          Edit
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() => {
            if (!window.confirm("Delete this memory?")) return;
            mutate({
              operation: "fact.delete",
              memoryId: revision.rootId,
              expectedRevision: revision.revision,
            });
          }}
        >
          Delete
        </Button>
      </div>
    </li>
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
  const inspectAtom = useMemo(
    () =>
      open && threadRef
        ? memoryEnvironment.inspect({
            environmentId: threadRef.environmentId,
            input: { threadId: threadRef.threadId },
          })
        : null,
    [open, threadRef],
  );
  const snapshot = useEnvironmentQuery(inspectAtom);
  const runMutation = useAtomCommand(memoryEnvironment.mutate, { reportFailure: false });
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const mutate = async (key: string, mutation: AkeruMemoryMutation) => {
    if (!threadRef) return;
    setBusyKey(key);
    try {
      const result = await runMutation({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, mutation },
      });
      if (result._tag === "Failure") {
        toastManager.add({ type: "error", title: "Could not update memory" });
      }
    } catch {
      toastManager.add({ type: "error", title: "Could not update memory" });
    } finally {
      setBusyKey(null);
    }
  };

  const conversation = snapshot.data?.conversation.current;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Memory</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-6">
          {!threadRef ? (
            <p className="text-sm text-muted-foreground">No conversation yet.</p>
          ) : snapshot.error ? (
            <p className="text-sm text-muted-foreground">Memory unavailable.</p>
          ) : snapshot.isPending && !snapshot.data ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <>
              <section className="space-y-2" aria-labelledby="conversation-memory-heading">
                <div className="flex items-center justify-between gap-3">
                  <h3 id="conversation-memory-heading" className="text-sm font-medium">
                    Conversation
                  </h3>
                  {conversation ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busyKey === "conversation"}
                      onClick={() =>
                        void mutate("conversation", { operation: "conversation.clear" })
                      }
                    >
                      Clear
                    </Button>
                  ) : null}
                </div>
                <div className="rounded-lg border border-border bg-muted/20 px-3 py-3 text-sm">
                  {conversation?.activeObservations ? (
                    <p className="whitespace-pre-wrap leading-5">
                      {conversation.activeObservations}
                    </p>
                  ) : (
                    <p className="text-muted-foreground">No conversation memory.</p>
                  )}
                </div>
              </section>

              <section className="space-y-2" aria-labelledby="pending-memory-heading">
                <h3 id="pending-memory-heading" className="text-sm font-medium">
                  Pending
                </h3>
                {snapshot.data?.pending.length ? (
                  <ul className="space-y-2">
                    {snapshot.data.pending.map((candidate) => (
                      <PendingMemory
                        key={candidate.candidateId}
                        candidate={candidate}
                        disabled={busyKey === candidate.candidateId}
                        decide={(decision) =>
                          void mutate(candidate.candidateId, {
                            operation: "candidate.decide",
                            decision: { candidateId: candidate.candidateId, decision },
                          })
                        }
                      />
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">No pending memory.</p>
                )}
              </section>

              <section className="space-y-2" aria-labelledby="durable-memory-heading">
                <h3 id="durable-memory-heading" className="text-sm font-medium">
                  Durable
                </h3>
                {snapshot.data?.durable.length ? (
                  <ul className="space-y-2">
                    {snapshot.data.durable.map((revision) => (
                      <DurableMemory
                        key={revision.rootId}
                        revision={revision}
                        disabled={busyKey === revision.rootId}
                        mutate={(mutation) => void mutate(revision.rootId, mutation)}
                      />
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">No durable memory.</p>
                )}
              </section>
            </>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
