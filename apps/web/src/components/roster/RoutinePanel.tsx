import { useEffect, useRef, useState } from "react";
import { PlusIcon } from "lucide-react";
import {
  type RoutineAdapterBot,
  type RoutineAdapterDraft,
  type RoutineAdapterItem,
  type RoutineAdapterProject,
} from "@akeru/client-runtime/routines";

import { useI18n } from "../../i18n";
import { Button } from "../ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { RoutineFormDialog, blankDraft, editDraft } from "./RoutineFormDialog";
import { RoutineCard, RoutineDetail, type RoutineActionProps } from "./RoutineCards";

export { RoutineDetail } from "./RoutineCards";

export { routineFormClosesOnOpenChange, showsWorkspacePicker } from "./RoutineFormDialog";

export { runStatusPresentation } from "./RoutineRunHistory";

export interface RoutinePanelProps extends RoutineActionProps {
  readonly botName: string;
  readonly listRequest?: number;
  readonly status: "loading" | "ready" | "error" | "unavailable";
  readonly error?: string | null;
  readonly routines?: readonly RoutineAdapterItem[];
  readonly projectOptions?: readonly RoutineAdapterProject[];
  /**
   * Other bots a routine can hand its work to. The owner is always offered first.
   * A bot with `canTakeWork: false` shows disabled with the reason.
   */
  readonly delegateOptions?: readonly RoutineAdapterBot[];
  readonly skillOptions?: readonly string[];
  readonly connectorOptions?: readonly string[];
  readonly busyRoutineId?: string | null;
  readonly onCreate?: (draft: RoutineAdapterDraft) => void | Promise<void>;
  /** True when routines cannot be created yet because the bot's chat has not started. */
  readonly createNeedsChat?: boolean;
  readonly onUpdate?: (routineId: string, draft: RoutineAdapterDraft) => void | Promise<void>;
  readonly onDelete?: (routineId: string) => void | Promise<void>;
}

const EMPTY_ROUTINES: readonly RoutineAdapterItem[] = [];

const EMPTY_PROJECT_OPTIONS: readonly RoutineAdapterProject[] = [];

const EMPTY_DELEGATE_OPTIONS: readonly RoutineAdapterBot[] = [];

/**
 * The routine focus lands on once a deleted one is gone: the row that takes its
 * place in the list, else the row above it, else nothing — meaning the Routines
 * heading, because the list it would have returned to is now empty.
 */
export function focusTargetAfterRoutineDelete(
  routineIds: readonly string[],
  deletedId: string,
): string | null {
  const index = routineIds.indexOf(deletedId);

  if (index === -1) return routineIds[0] ?? null;

  return routineIds[index + 1] ?? routineIds[index - 1] ?? null;
}

export function RoutinePanel({
  botName,
  listRequest = 0,
  status,
  error,
  routines = EMPTY_ROUTINES,
  projectOptions = EMPTY_PROJECT_OPTIONS,
  delegateOptions = EMPTY_DELEGATE_OPTIONS,
  busyRoutineId = null,
  onCreate,
  createNeedsChat = false,
  onUpdate,
  onDelete,
  ...actions
}: RoutinePanelProps) {
  const { t } = useI18n();
  const [creating, setCreating] = useState(false);
  const [editorRoutine, setEditorRoutine] = useState<RoutineAdapterItem | null>(null);
  const [deleteRoutine, setDeleteRoutine] = useState<RoutineAdapterItem | null>(null);
  const [deletingRoutineId, setDeletingRoutineId] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const deleteBusyRef = useRef(false);
  const [deleteError, setDeleteError] = useState(false);
  const [openRoutineId, setOpenRoutineId] = useState<string | null>(null);
  // A list request (a receipt opening the routine list) lands on the heading,
  // not on the row of the routine it closed.
  const listRequested = useRef(false);
  useEffect(() => {
    if (listRequest === 0) return;
    setOpenRoutineId((current) => {
      if (current !== null) listRequested.current = true;

      return null;
    });
  }, [listRequest]);
  const openRoutine = routines.find((routine) => routine.id === openRoutineId) ?? null;

  // Opening a routine replaces the list under the pointer, so focus follows it
  // in and returns to the row you came from rather than to the top of the page.
  const listRef = useRef<HTMLDivElement | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const previousOpenId = useRef<string | null>(null);
  // Deleting is the one close that cannot go back where it came from: the row is
  // on its way out of the projection. The delete names its survivor here, and
  // holds it past the close so the confirm dialog does not restore focus over it.
  const deletedFocusTarget = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (deletingRoutineId === null || routines.some((routine) => routine.id === deletingRoutineId))
      return;
    setOpenRoutineId(null);
    setDeletingRoutineId(null);
  }, [deletingRoutineId, routines]);
  useEffect(() => {
    if (openRoutineId !== null && previousOpenId.current === null) {
      detailRef.current?.querySelector<HTMLElement>("[data-routine-back]")?.focus();
    } else if (openRoutineId === null && previousOpenId.current !== null) {
      const target = listRequested.current
        ? null
        : deletedFocusTarget.current === undefined
          ? previousOpenId.current
          : deletedFocusTarget.current;

      listRequested.current = false;

      const rows =
        target === null
          ? []
          : (listRef.current?.querySelectorAll<HTMLElement>("[data-routine-row]") ?? []);

      let restored = false;

      for (const row of rows) {
        if (row.dataset.routineRow === target) {
          row.focus();
          restored = true;
          break;
        }
      }

      if (!restored) headingRef.current?.focus();
    }

    previousOpenId.current = openRoutineId;
  }, [openRoutineId]);

  // The environment cannot run routines, so there is nothing to show or act on.
  if (status === "unavailable") return null;

  return (
    <section className="mt-6">
      {openRoutine === null ? (
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium" ref={headingRef} tabIndex={-1}>
            {t("Routines")}
          </h3>
          {onCreate && status === "ready" && routines.length > 0 ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("New routine")}
              onClick={() => setCreating(true)}
            >
              <PlusIcon aria-hidden />
            </Button>
          ) : null}
        </div>
      ) : null}
      {status === "loading" ? (
        <p className="mt-2 text-xs text-muted-foreground" aria-label={t("Loading routines")}>
          {t("Loading")}
        </p>
      ) : status === "error" ? (
        <p className="mt-2 text-xs text-destructive">{error || t("Could not load routines.")}</p>
      ) : openRoutine !== null ? (
        <div ref={detailRef}>
          <RoutineDetail
            routine={openRoutine}
            projectName={
              projectOptions.find((project) => project.id === openRoutine.projectId)?.name ??
              openRoutine.projectId
            }
            doneBy={
              openRoutine.delegateToBotId === null
                ? null
                : (delegateOptions.find((bot) => bot.id === openRoutine.delegateToBotId)?.name ??
                  t("Unknown bot"))
            }
            busy={busyRoutineId === openRoutine.id}
            onBack={() => setOpenRoutineId(null)}
            onEdit={() => setEditorRoutine(openRoutine)}
            onDeleteRequest={() => setDeleteRoutine(openRoutine)}
            {...(actions.onApproveProcedure
              ? { onApproveProcedure: actions.onApproveProcedure }
              : {})}
            {...(actions.onDryRun ? { onDryRun: actions.onDryRun } : {})}
            {...(actions.onRunNow ? { onRunNow: actions.onRunNow } : {})}
            {...(actions.onSetEnabled ? { onSetEnabled: actions.onSetEnabled } : {})}
            {...(actions.onSetPaused ? { onSetPaused: actions.onSetPaused } : {})}
          />
        </div>
      ) : routines.length === 0 ? (
        <>
          <p className="mt-2 text-xs text-muted-foreground">
            {!onCreate && createNeedsChat
              ? t(
                  "Routines report to your chat with {botName}. Send {botName} a message to start the chat, then add a routine here.",
                  { botName },
                )
              : t("None yet. Ask {botName} to create one.", { botName })}
          </p>
          {onCreate ? (
            // A quiet row, not a call to action: its label lines up with the
            // sheet's row labels and only the hover fill reaches past them.
            <Button
              variant="ghost-quiet"
              size="row"
              className="-mx-2 mt-1 w-[calc(100%+1rem)] justify-start"
              onClick={() => setCreating(true)}
            >
              <PlusIcon aria-hidden />
              {t("New routine")}
            </Button>
          ) : null}
        </>
      ) : (
        <div className="mt-2 space-y-1.5" ref={listRef}>
          {routines.map((routine) => (
            <RoutineCard
              key={routine.id}
              routine={routine}
              busy={busyRoutineId === routine.id}
              onOpen={() => {
                deletedFocusTarget.current = undefined;
                setOpenRoutineId(routine.id);
              }}
              {...(actions.onSetEnabled ? { onSetEnabled: actions.onSetEnabled } : {})}
              {...(actions.onSetPaused ? { onSetPaused: actions.onSetPaused } : {})}
            />
          ))}
        </div>
      )}
      {creating && onCreate ? (
        <RoutineFormDialog
          title="New routine"
          submitLabel="Create routine"
          initialDraft={blankDraft(projectOptions)}
          botName={botName}
          projectOptions={projectOptions}
          delegateOptions={delegateOptions}
          onSubmit={onCreate}
          onClose={() => setCreating(false)}
        />
      ) : null}
      {editorRoutine ? (
        <RoutineFormDialog
          title="Edit routine"
          submitLabel="Save changes"
          initialDraft={editDraft(editorRoutine)}
          botName={botName}
          projectOptions={projectOptions}
          delegateOptions={delegateOptions}
          {...(onUpdate ? { onSubmit: (draft) => onUpdate(editorRoutine.id, draft) } : {})}
          onClose={() => setEditorRoutine(null)}
        />
      ) : null}
      <AlertDialog
        open={deleteRoutine !== null}
        onOpenChange={(open) => !open && !deleteBusyRef.current && setDeleteRoutine(null)}
      >
        <AlertDialogPopup
          // Cancelling belongs back on the Delete control it came from. Deleting does
          // not: that control and its routine are both leaving, so the list effect
          // places focus on the survivor and this must not move it afterwards.
          finalFocus={() => deletedFocusTarget.current === undefined}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("Delete routine “{name}”?", { name: deleteRoutine?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("This removes the schedule and its run history.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={deleteBusy} />}>
              {t("Cancel")}
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={deleteBusy || !onDelete}
              onClick={() => {
                if (!deleteRoutine || !onDelete || deleteBusyRef.current) return;
                const id = deleteRoutine.id;
                deleteBusyRef.current = true;
                setDeleteBusy(true);
                setDeleteError(false);
                void Promise.resolve()
                  .then(() => onDelete(id))
                  .then(() => {
                    deletedFocusTarget.current = focusTargetAfterRoutineDelete(
                      routines.map((item) => item.id),
                      id,
                    );
                    setDeletingRoutineId(id);
                    setDeleteRoutine(null);
                  })
                  .catch(() => setDeleteError(true))
                  .finally(() => {
                    deleteBusyRef.current = false;
                    setDeleteBusy(false);
                  });
              }}
            >
              {deleteBusy ? t("Deleting…") : t("Delete")}
            </Button>
          </AlertDialogFooter>
          {deleteError ? (
            <p role="alert" className="text-sm text-destructive">
              {t("Could not delete routine")}. {t("Try again")}
            </p>
          ) : null}
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}
