import {
  DURABLE_MEMORY_EXPORT_SCOPES,
  type DurableMemoryExportScope,
  durableMemoryExportFileName,
  groupImportPreview,
  type ImportConflictDecision,
  memoryArchiveSchemaVersion,
  resolveImportConflicts,
} from "@t3tools/client-runtime/durable-memory";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AkeruMarkdownMemoryArchiveV3,
  AkeruMemoryArchiveV2,
  type AkeruMarkdownMemoryImportPreview,
  type AkeruMemoryImportPreview,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useMemo, useRef, useState } from "react";

import { DurableImportReview, DurableScopePicker } from "./DurableMemoryPanels";

import { memoryEnvironment } from "../../state/memory";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

const decodeArchive = Schema.decodeUnknownSync(AkeruMarkdownMemoryArchiveV3);
const decodeDurableArchive = Schema.decodeUnknownSync(AkeruMemoryArchiveV2);

function download(value: unknown, fileName: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

type PendingImport =
  | {
      readonly kind: "notes";
      readonly archive: AkeruMarkdownMemoryArchiveV3;
      readonly preview: AkeruMarkdownMemoryImportPreview;
    }
  | {
      readonly kind: "durable";
      readonly archive: AkeruMemoryArchiveV2;
      readonly preview: AkeruMemoryImportPreview;
    };

export function BotMemoryTransfer({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const exportArchive = useAtomCommand(memoryEnvironment.exportArchive, { reportFailure: false });
  const previewImport = useAtomCommand(memoryEnvironment.previewImport, { reportFailure: false });
  const applyImport = useAtomCommand(memoryEnvironment.applyImport, { reportFailure: false });
  const exportDurable = useAtomCommand(memoryEnvironment.exportDurableArchive, {
    reportFailure: false,
  });
  const previewDurable = useAtomCommand(memoryEnvironment.previewDurableImport, {
    reportFailure: false,
  });
  const applyDurable = useAtomCommand(memoryEnvironment.applyDurableImport, {
    reportFailure: false,
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [exportScope, setExportScope] = useState<DurableMemoryExportScope>("bot");
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [choices, setChoices] = useState<Record<string, ImportConflictDecision>>({});

  // Local facts for the archive's scope, so each conflict shows what would be replaced.
  const durableTarget = pending?.kind === "durable" ? pending.archive.target : null;
  const localQuery = useEnvironmentQuery(
    durableTarget && durableTarget !== "all"
      ? memoryEnvironment.listFacts({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, target: durableTarget },
        })
      : null,
  );
  const durableReview = useMemo(() => {
    if (pending?.kind !== "durable") return null;
    return {
      groups: groupImportPreview({
        preview: pending.preview,
        archive: pending.archive,
        localFacts: localQuery.data?.facts ?? [],
      }),
      resolution: resolveImportConflicts(pending.preview, choices),
    };
  }, [pending, choices, localQuery.data]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Memory transfer failed.");
    } finally {
      setBusy(false);
    }
  };
  const startReview = (next: PendingImport | null) => {
    setChoices({});
    setPending(next);
  };

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-medium">Transfer memory</h3>
      <p className="text-xs text-muted-foreground">
        Export bot notes and chat observations, or durable facts for one scope. Review an import
        before anything changes.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const result = await exportArchive({
                environmentId: threadRef.environmentId,
                input: { threadId: threadRef.threadId, target: "thread", complete: true },
              });
              if (result._tag === "Failure") throw squashAtomCommandFailure(result);
              download(result.value, `akeru-memory-${threadRef.threadId}.json`);
            })
          }
        >
          Export notes
        </Button>
      </div>
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Durable facts:{" "}
          {DURABLE_MEMORY_EXPORT_SCOPES.find((option) => option.scope === exportScope)?.description}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <DurableScopePicker
            label="Durable export scope"
            options={DURABLE_MEMORY_EXPORT_SCOPES}
            value={exportScope}
            disabled={busy}
            onChange={setExportScope}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await exportDurable({
                  environmentId: threadRef.environmentId,
                  input: { threadId: threadRef.threadId, target: exportScope, complete: true },
                });
                if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                download(
                  result.value,
                  durableMemoryExportFileName(exportScope, threadRef.threadId),
                );
              })
            }
          >
            Export durable facts
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => fileInputRef.current?.click()}
        >
          Import memory archive
        </Button>
      </div>
      <input
        ref={fileInputRef}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        type="file"
        accept="application/json,.json"
        disabled={busy}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (!file) return;
          startReview(null);
          void run(async () => {
            const raw: unknown = JSON.parse(await file.text());
            if (memoryArchiveSchemaVersion(raw) === 2) {
              const archive = decodeDurableArchive(raw);
              if (archive.target === "all") {
                throw new Error(
                  "All-memory archives can't be imported. Export and import one scope at a time.",
                );
              }
              const result = await previewDurable({
                environmentId: threadRef.environmentId,
                input: { threadId: threadRef.threadId, target: archive.target, archive },
              });
              if (result._tag === "Failure") throw squashAtomCommandFailure(result);
              startReview({ kind: "durable", archive, preview: result.value });
              return;
            }
            const archive = decodeArchive(raw);
            const result = await previewImport({
              environmentId: threadRef.environmentId,
              input: { threadId: threadRef.threadId, archive },
            });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            startReview({ kind: "notes", archive, preview: result.value });
          });
        }}
      />
      {pending?.kind === "notes" ? (
        <div className="space-y-2 text-sm">
          {pending.preview.documents.map((item) => (
            <p key={item.target}>
              {item.target}: {item.classification}, {item.charCount} / {item.charLimit} characters
            </p>
          ))}
          <p>
            {pending.preview.restoresObservations
              ? "This import will replace this chat's observations."
              : "Chat observations are unchanged."}
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => startReview(null)}>
              Cancel import
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await applyImport({
                    environmentId: threadRef.environmentId,
                    input: {
                      threadId: threadRef.threadId,
                      archive: pending.archive,
                      previewHash: pending.preview.previewHash,
                    },
                  });
                  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                  startReview(null);
                })
              }
            >
              Apply import
            </Button>
          </div>
        </div>
      ) : null}
      {pending?.kind === "durable" && durableReview ? (
        <DurableImportReview
          groups={durableReview.groups}
          choices={choices}
          unresolvedCount={
            durableReview.resolution.ready ? 0 : durableReview.resolution.unresolved.length
          }
          busy={busy}
          onChoose={(rootId, decision) =>
            setChoices((current) => ({ ...current, [rootId]: decision }))
          }
          onCancel={() => startReview(null)}
          onApply={() => {
            const resolution = durableReview.resolution;
            if (!resolution.ready) return;
            void run(async () => {
              const result = await applyDurable({
                environmentId: threadRef.environmentId,
                input: {
                  threadId: threadRef.threadId,
                  target: pending.archive.target,
                  archive: pending.archive,
                  previewHash: pending.preview.previewHash,
                  resolutions: resolution.resolutions,
                },
              });
              if (result._tag === "Failure") throw squashAtomCommandFailure(result);
              startReview(null);
              setNotice(
                `Imported ${result.value.imported}, changed ${result.value.changed}, skipped ${result.value.skipped}.`,
              );
            });
          }}
        />
      ) : null}
    </section>
  );
}
