import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  PortabilityApplyImportResult,
  PortabilityImportItem,
  PortabilityImportPreview,
  PortabilityProjectFolderMap,
  ProjectId,
} from "@t3tools/contracts";
import { useRef, useState } from "react";

import { usePrimaryEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import { readLocalApi } from "../../localApi";
import { portabilityEnvironment } from "../../state/portability";
import { useAtomCommand } from "../../state/use-atom-command";
import { resolveProjectPickerTarget } from "../../wslPaths";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
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
  portabilityProjectPickerTarget,
  updatePortabilityProjectFolderMap,
} from "./PortabilitySettings.logic";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

interface ImportPreviewState {
  readonly contents: string;
  readonly filename: string;
  readonly preview: PortabilityImportPreview;
  readonly projectFolders: PortabilityProjectFolderMap;
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

function ImportPreview({
  preview,
  projectFolders,
  canPickProjectFolders,
  pending,
  onProjectFolderChange,
  onProjectFolderPick,
}: {
  readonly preview: PortabilityImportPreview;
  readonly projectFolders: PortabilityProjectFolderMap;
  readonly canPickProjectFolders: boolean;
  readonly pending: boolean;
  readonly onProjectFolderChange: (projectId: ProjectId, destination: string) => void;
  readonly onProjectFolderPick: (projectId: ProjectId, destination: string | null) => void;
}) {
  const unsupported = preview.unsupported.filter((item) => item.count > 0);
  return (
    <div className="space-y-5">
      {preview.projectFolders.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold text-foreground">Project locations</h3>
          <p className="text-xs text-muted-foreground">
            Choose an existing folder for each project. Akeru Bot links the project to the folder
            without copying its files.
          </p>
          {preview.projectFolders.map((project) => (
            <div key={project.projectId} className="space-y-1">
              <label className="text-xs text-foreground/80" htmlFor={`folder-${project.projectId}`}>
                {project.title}
              </label>
              <div className="flex gap-1.5">
                <DraftInput
                  id={`folder-${project.projectId}`}
                  size="compact"
                  disabled={pending}
                  value={projectFolders[project.projectId] ?? project.destination ?? ""}
                  placeholder={project.workspaceName}
                  onCommit={(destination) => onProjectFolderChange(project.projectId, destination)}
                />
                {canPickProjectFolders ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={pending}
                    onClick={() => onProjectFolderPick(project.projectId, project.destination)}
                  >
                    Choose
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
        </section>
      ) : null}

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
        <h3 className="text-xs font-semibold text-foreground">Not transferred</h3>
        <ul className="space-y-1 text-xs text-muted-foreground">
          {preview.skippedSecrets.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          After restore, sign in to providers and reconnect imported MCP servers on this device.
        </p>
      </section>

      {unsupported.length > 0 ? (
        <section className="space-y-1.5">
          <h3 className="text-xs font-semibold text-foreground">Not restored</h3>
          <ul className="space-y-2 text-xs text-muted-foreground">
            {unsupported.map((item) => (
              <li key={item.kind}>
                <span className="font-medium text-foreground/80">
                  {item.kind} ({item.count})
                </span>
                <span className="block">{item.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function importResultDescription(result: PortabilityApplyImportResult): string {
  const counts = [
    `${result.applied} restored`,
    ...(result.skipped > 0 ? [`${result.skipped} skipped`] : []),
    ...(result.failed > 0 ? [`${result.failed} failed`] : []),
    ...(result.partial > 0 ? [`${result.partial} partly restored`] : []),
  ];
  const firstFailure = result.failures[0];
  return `${counts.join(". ")}.${firstFailure ? ` ${firstFailure.title}: ${firstFailure.message}` : ""}`;
}

export function PortabilitySettings() {
  const environmentId = usePrimaryEnvironmentId();
  const primaryEnvironment = usePrimaryEnvironment();
  const projectPickerTarget = portabilityProjectPickerTarget(
    primaryEnvironment?.entry.target ?? null,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const projectFoldersRef = useRef<PortabilityProjectFolderMap>({});
  const importSessionIdRef = useRef(0);
  const previewRequestIdRef = useRef(0);
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
    importSessionIdRef.current += 1;
    const requestId = ++previewRequestIdRef.current;
    projectFoldersRef.current = {};
    setPending("preview");
    try {
      const contents = await file.text();
      const result = await previewImport({ environmentId, input: { contents } });
      if (requestId !== previewRequestIdRef.current) return;
      setPending(null);
      if (result._tag === "Failure") {
        reportFailure("Could not preview archive", result);
        return;
      }
      setImportState({ contents, filename: file.name, preview: result.value, projectFolders: {} });
    } catch (error) {
      if (requestId !== previewRequestIdRef.current) return;
      setPending(null);
      toastManager.add({
        type: "error",
        title: "Could not read archive",
        description: error instanceof Error ? error.message : "The file could not be read.",
      });
    }
  };

  const handleProjectFolder = async (projectId: ProjectId, destination: string) => {
    if (environmentId === null || importState === null) return;
    const reviewedProjectFolders = projectFoldersRef.current;
    const projectFolders = updatePortabilityProjectFolderMap(
      projectFoldersRef.current,
      projectId,
      destination,
    );
    projectFoldersRef.current = projectFolders;
    const requestId = ++previewRequestIdRef.current;
    const contents = importState.contents;
    setImportState((current) =>
      current?.contents === contents ? { ...current, projectFolders } : current,
    );
    setPending("preview");
    const result = await previewImport({
      environmentId,
      input: { contents, projectFolders },
    });
    if (requestId !== previewRequestIdRef.current) return;
    setPending(null);
    if (result._tag === "Failure") {
      projectFoldersRef.current = reviewedProjectFolders;
      setImportState((current) =>
        current?.contents === contents
          ? { ...current, projectFolders: reviewedProjectFolders }
          : current,
      );
      reportFailure("Could not use project folder", result);
      return;
    }
    setImportState((current) =>
      current?.contents === contents && current.projectFolders === projectFolders
        ? { ...current, preview: result.value }
        : current,
    );
  };

  const handleProjectFolderPick = async (projectId: ProjectId, destination: string | null) => {
    if (environmentId === null || importState === null) return;
    const importSessionId = importSessionIdRef.current;
    if (!window.desktopBridge || projectPickerTarget === undefined) {
      toastManager.add({
        type: "error",
        title: "Folder picker unavailable",
        description: "Enter an absolute folder path, or open Akeru Bot on desktop.",
      });
      return;
    }
    try {
      const wslConfiguration = await window.desktopBridge.getWslState().catch(() => null);
      const targetEnvironmentId = resolveProjectPickerTarget({
        browseEnvironmentId: environmentId,
        primaryEnvironmentId: environmentId,
        // Settings only targets the primary environment. The WSL state routes a WSL-only primary.
        desktopInstanceId: projectPickerTarget,
        wslConfiguration,
      });
      const picked = await readLocalApi()?.dialogs.pickFolder({
        ...(destination ? { initialPath: destination } : {}),
        ...(targetEnvironmentId ? { targetEnvironmentId } : {}),
      });
      if (picked && importSessionId === importSessionIdRef.current) {
        await handleProjectFolder(projectId, picked);
      }
    } catch (error) {
      if (importSessionId !== importSessionIdRef.current) return;
      toastManager.add({
        type: "error",
        title: "Could not choose project folder",
        description: error instanceof Error ? error.message : "The folder could not be selected.",
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
        projectFolders: importState.projectFolders,
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
    else {
      importSessionIdRef.current += 1;
      projectFoldersRef.current = {};
      setImportState(null);
    }
    toastManager.add({
      type: hasFailures ? "error" : "success",
      title: hasFailures ? "Archive partly restored" : "Archive restored",
      description: importResultDescription(result.value),
    });
  };

  return (
    <>
      <SettingsRow
        {...searchableSetting("data-portability")}
        description="Export Akeru settings, project links, and history, or restore them on another environment. Project files and credentials are not included."
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
            importSessionIdRef.current += 1;
            previewRequestIdRef.current += 1;
            projectFoldersRef.current = {};
            setPending(null);
            setImportState(null);
            setApplyResult(null);
          }
        }}
      >
        <DialogPopup className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Restore preview</DialogTitle>
            <DialogDescription>
              {importState?.filename}. Review what Akeru Bot will restore on this environment.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {importState ? (
              <ImportPreview
                preview={importState.preview}
                projectFolders={importState.projectFolders}
                canPickProjectFolders={
                  window.desktopBridge !== undefined && projectPickerTarget !== undefined
                }
                pending={pending !== null}
                onProjectFolderChange={(projectId, destination) =>
                  void handleProjectFolder(projectId, destination)
                }
                onProjectFolderPick={(projectId, destination) =>
                  void handleProjectFolderPick(projectId, destination)
                }
              />
            ) : null}
            {applyResult && applyResult.failures.length > 0 ? (
              <section className="mt-5 space-y-1.5">
                <h3 className="text-xs font-semibold text-destructive">Restore failures</h3>
                <ul className="space-y-2 text-xs text-muted-foreground">
                  {applyResult.failures.map((failure) => (
                    <li key={`${failure.recordType}:${failure.id}`}>
                      <span className="font-medium text-foreground/80">{failure.title}</span>
                      <span className="block">
                        {failure.partial ? "Partly restored. " : "Not restored. "}
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
              onClick={() => {
                importSessionIdRef.current += 1;
                previewRequestIdRef.current += 1;
                projectFoldersRef.current = {};
                setPending(null);
                setImportState(null);
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={
                importState === null ||
                pending !== null ||
                applyResult !== null ||
                !canApplyPortabilityPreview(importState.preview)
              }
              onClick={() => void handleApply()}
            >
              {pending === "apply" ? "Restoring..." : "Restore"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
