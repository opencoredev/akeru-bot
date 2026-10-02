import { Predicate } from "effect";
import type {
  PortabilityApplyImportResult,
  PortabilityProjectFolderMap,
  ProjectId,
} from "@akeru/contracts";
import { useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { usePrimaryEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import { readLocalApi } from "../../localApi";
import { portabilityEnvironment } from "../../state/portability";
import { useAtomCommand } from "../../state/use-atom-command";
import { resolveProjectPickerTarget } from "../../wslPaths";
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
  portabilityProjectPickerTarget,
  updatePortabilityProjectFolderMap,
} from "./PortabilitySettings.logic";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  ImportPreviewState,
  ImportPreview,
  importResultDescription,
} from "./PortabilityImportPreview";
import { downloadArchive, reportFailure } from "./portabilityPresentation";

export function PortabilitySettings() {
  const { t } = useI18n();
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

    if (Predicate.isTagged(result, "Failure")) {
      reportFailure(t("Could not export archive"), result, t);

      return;
    }

    downloadArchive(result.value.filename, result.value.contents);
    toastManager.add({ type: "success", title: t("Archive exported") });
  };

  const handleFile = async (file: File) => {
    if (environmentId === null) return;
    setApplyResult(null);
    const fileError = portabilityArchiveFileError(file.size);

    if (fileError) {
      toastManager.add({
        type: "error",
        title: t("Could not read archive"),
        description: fileError,
      });

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

      if (Predicate.isTagged(result, "Failure")) {
        reportFailure(t("Could not preview archive"), result, t);

        return;
      }

      setImportState({ contents, filename: file.name, preview: result.value, projectFolders: {} });
    } catch (error) {
      if (requestId !== previewRequestIdRef.current) return;
      setPending(null);
      toastManager.add({
        type: "error",
        title: t("Could not read archive"),
        description: error instanceof Error ? error.message : t("The file could not be read."),
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

    if (Predicate.isTagged(result, "Failure")) {
      projectFoldersRef.current = reviewedProjectFolders;
      setImportState((current) =>
        current?.contents === contents
          ? { ...current, projectFolders: reviewedProjectFolders }
          : current,
      );
      reportFailure(t("Could not use project folder"), result, t);

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
        title: t("Folder picker unavailable"),
        description: t("Enter an absolute folder path, or open Akeru Bot on desktop."),
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
        title: t("Could not choose project folder"),
        description:
          error instanceof Error ? error.message : t("The folder could not be selected."),
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

    if (Predicate.isTagged(result, "Failure")) {
      reportFailure(t("Could not import archive"), result, t);

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
      title: hasFailures ? t("Archive partly restored") : t("Archive restored"),
      description: importResultDescription(result.value, t),
    });
  };

  return (
    <>
      <SettingsRow
        {...searchableSetting("data-portability", t)}
        description={t(
          "Export Akeru settings, project links, and history, or restore them on another environment. Project files and credentials are not included.",
        )}
        control={
          <div className="flex items-center gap-1.5">
            <Button
              size="xs"
              variant="outline"
              disabled={environmentId === null || pending !== null}
              onClick={() => fileInputRef.current?.click()}
            >
              {pending === "preview" ? t("Reading...") : t("Import")}
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={environmentId === null || pending !== null}
              onClick={() => void handleExport()}
            >
              {pending === "export" ? t("Exporting...") : t("Export")}
            </Button>
            <input
              ref={fileInputRef}
              className="sr-only"
              type="file"
              accept=".archive,application/json"
              aria-label={t("Import Akeru archive")}
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
            <DialogTitle>{t("Restore preview")}</DialogTitle>
            <DialogDescription>
              {t("{filename}. Review what Akeru Bot will restore on this environment.", {
                filename: importState?.filename ?? "",
              })}
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
                <h3 className="text-xs font-semibold text-destructive">{t("Restore failures")}</h3>
                <ul className="space-y-2 text-xs text-muted-foreground">
                  {applyResult.failures.map((failure) => (
                    <li key={`${failure.recordType}:${failure.id}`}>
                      <span className="font-medium text-foreground/80">{failure.title}</span>
                      <span className="block">
                        {failure.partial ? t("Partly restored.") : t("Not restored.")}{" "}
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
              {t("Cancel")}
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
              {pending === "apply" ? t("Restoring...") : t("Restore")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
