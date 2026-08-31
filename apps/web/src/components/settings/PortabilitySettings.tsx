import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  PortabilityApplyImportResult,
  PortabilityImportItem,
  PortabilityImportPreview,
} from "@t3tools/contracts";
import { useRef, useState } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { portabilityEnvironment } from "../../state/portability";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";
import {
  canApplyPortabilityPreview,
  portabilityArchiveFileError,
} from "./PortabilitySettings.logic";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

interface ImportPreviewState {
  readonly contents: string;
  readonly filename: string;
  readonly preview: PortabilityImportPreview;
}

function downloadArchive(filename: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>): void {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : "The command failed.",
  });
}

function ImportItems({
  title,
  items,
}: {
  readonly title: string;
  readonly items: readonly PortabilityImportItem[];
}) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-semibold text-foreground">
        {title} <span className="text-muted-foreground">{items.length}</span>
      </h3>
      {items.length > 0 ? (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {items.map((item) => (
            <li key={`${item.recordType}:${item.id}`} className="flex justify-between gap-4">
              <span className="truncate text-foreground/80">{item.title}</span>
              <span className="shrink-0">{item.recordType}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function ImportPreview({ preview }: { readonly preview: PortabilityImportPreview }) {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <ImportItems title="Additions" items={preview.additions} />
        <ImportItems title="Changes" items={preview.changes} />
        <ImportItems title="Conflicts" items={preview.conflicts} />
      </div>

      <section className="space-y-1.5">
        <h3 className="text-xs font-semibold text-foreground">
          Missing providers{" "}
          <span className="text-muted-foreground">{preview.missingProviders.length}</span>
        </h3>
        {preview.missingProviders.length > 0 ? (
          <p className="text-xs text-muted-foreground">{preview.missingProviders.join(", ")}</p>
        ) : null}
      </section>

      <section className="space-y-1.5">
        <h3 className="text-xs font-semibold text-foreground">Secrets not included</h3>
        <ul className="space-y-1 text-xs text-muted-foreground">
          {preview.skippedSecrets.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section className="space-y-1.5">
        <h3 className="text-xs font-semibold text-foreground">Unsupported</h3>
        <ul className="space-y-2 text-xs text-muted-foreground">
          {preview.unsupported.map((item) => (
            <li key={item.kind}>
              <span className="font-medium text-foreground/80">
                {item.kind} ({item.count})
              </span>
              <span className="block">{item.reason}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function importResultDescription(result: PortabilityApplyImportResult): string {
  const counts = [
    `${result.applied} applied`,
    ...(result.skipped > 0 ? [`${result.skipped} skipped`] : []),
    ...(result.failed > 0 ? [`${result.failed} failed`] : []),
    ...(result.partial > 0 ? [`${result.partial} partly applied`] : []),
  ];
  const firstFailure = result.failures[0];
  return `${counts.join(". ")}.${firstFailure ? ` ${firstFailure.title}: ${firstFailure.message}` : ""}`;
}

export function PortabilitySettings() {
  const environmentId = usePrimaryEnvironmentId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const exportArchive = useAtomCommand(portabilityEnvironment.exportArchive, {
    reportFailure: false,
  });
  const previewImport = useAtomCommand(portabilityEnvironment.previewImport, {
    reportFailure: false,
  });
  const applyImport = useAtomCommand(portabilityEnvironment.applyImport, {
    reportFailure: false,
  });
  const [pending, setPending] = useState<"export" | "preview" | "apply" | null>(null);
  const [importState, setImportState] = useState<ImportPreviewState | null>(null);
  const [applyResult, setApplyResult] = useState<PortabilityApplyImportResult | null>(null);

  const handleExport = async () => {
    if (environmentId === null) return;
    setPending("export");
    const result = await exportArchive({ environmentId, input: {} });
    setPending(null);
    if (result._tag === "Failure") {
      reportFailure("Could not export archive", result);
      return;
    }
    downloadArchive(result.value.filename, result.value.contents);
    toastManager.add({ type: "success", title: "Archive exported" });
  };

  const handleFile = async (file: File) => {
    if (environmentId === null) return;
    setApplyResult(null);
    const fileError = portabilityArchiveFileError(file.size);
    if (fileError) {
      toastManager.add({ type: "error", title: "Could not read archive", description: fileError });
      return;
    }
    setPending("preview");
    try {
      const contents = await file.text();
      const result = await previewImport({ environmentId, input: { contents } });
      setPending(null);
      if (result._tag === "Failure") {
        reportFailure("Could not preview archive", result);
        return;
      }
      setImportState({ contents, filename: file.name, preview: result.value });
    } catch (error) {
      setPending(null);
      toastManager.add({
        type: "error",
        title: "Could not read archive",
        description: error instanceof Error ? error.message : "The file could not be read.",
      });
    }
  };

  const handleApply = async () => {
    if (environmentId === null || importState === null) return;
    setPending("apply");
    const result = await applyImport({
      environmentId,
      input: {
        contents: importState.contents,
        expectedSnapshotSequence: importState.preview.snapshotSequence,
        expectedStateChecksum: importState.preview.stateChecksum,
      },
    });
    setPending(null);
    if (result._tag === "Failure") {
      reportFailure("Could not import archive", result);
      return;
    }
    const hasFailures = result.value.failed > 0 || result.value.partial > 0;
    if (hasFailures) setApplyResult(result.value);
    else setImportState(null);
    toastManager.add({
      type: hasFailures ? "error" : "success",
      title: hasFailures ? "Archive partly imported" : "Archive imported",
      description: importResultDescription(result.value),
    });
  };

  return (
    <>
      <SettingsRow
        {...searchableSetting("data-portability")}
        description="Export safe settings, workspaces, and conversation history, or preview an archive before import."
        control={
          <div className="flex items-center gap-1.5">
            <Button
              size="xs"
              variant="outline"
              disabled={environmentId === null || pending !== null}
              onClick={() => fileInputRef.current?.click()}
            >
              {pending === "preview" ? "Reading..." : "Import"}
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={environmentId === null || pending !== null}
              onClick={() => void handleExport()}
            >
              {pending === "export" ? "Exporting..." : "Export"}
            </Button>
            <input
              ref={fileInputRef}
              className="sr-only"
              type="file"
              accept=".archive,application/json"
              aria-label="Import Akeru archive"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) void handleFile(file);
              }}
            />
          </div>
        }
      />

      <Dialog
        open={importState !== null}
        onOpenChange={(open) => {
          if (!open && pending !== "apply") {
            setImportState(null);
            setApplyResult(null);
          }
        }}
      >
        <DialogPopup className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Import preview</DialogTitle>
            <DialogDescription>
              {importState?.filename}. MCP servers stay disabled until you reconnect their secrets.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {importState ? <ImportPreview preview={importState.preview} /> : null}
            {applyResult && applyResult.failures.length > 0 ? (
              <section className="mt-5 space-y-1.5">
                <h3 className="text-xs font-semibold text-destructive">Restore failures</h3>
                <ul className="space-y-2 text-xs text-muted-foreground">
                  {applyResult.failures.map((failure) => (
                    <li key={`${failure.recordType}:${failure.id}`}>
                      <span className="font-medium text-foreground/80">{failure.title}</span>
                      <span className="block">
                        {failure.partial ? "Partly applied. " : "Not applied. "}
                        {failure.message}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={pending === "apply"}
              onClick={() => setImportState(null)}
            >
              Cancel
            </Button>
            <Button
              disabled={
                importState === null ||
                pending === "apply" ||
                applyResult !== null ||
                !canApplyPortabilityPreview(importState.preview)
              }
              onClick={() => void handleApply()}
            >
              {pending === "apply" ? "Applying..." : "Apply safe changes"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
