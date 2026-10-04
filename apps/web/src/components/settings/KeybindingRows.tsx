import { type ServerUpsertKeybindingInput } from "@akeru/contracts";
import { ChevronRightIcon, EllipsisIcon, XIcon } from "lucide-react";
import { type ReactNode, useId, useReducer } from "react";
import { useI18n } from "../../i18n";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  ConditionPopover,
  createKeybindingRowDraft,
  keybindingRowDraftReducer,
  rowKeybindingTarget,
  ShortcutRecorder,
} from "./KeybindingEditors";
import { KeybindingConflictWarning, KeyCaps } from "./KeybindingPresentation";
import {
  type KeybindingRow,
  type KeybindingSeries,
  commandLabel,
  keybindingConflictLabels,
} from "./KeybindingsSettings.logic";
import {
  type WhenVariableOption,
  describeWhenExpression,
  whenAstToExpression,
} from "./KeybindingWhen.logic";

export function SourceBadge({ source }: { source: KeybindingRow["source"] }) {
  const { t } = useI18n();

  if (source === "Default") {
    return (
      <Badge variant="keybinding-default" size="sm">
        {t("Default")}
      </Badge>
    );
  }

  return (
    <Badge variant="keybinding-custom" size="sm">
      {t("Custom")}
    </Badge>
  );
}

// Keeps shortcut chips aligned when a row has no actions menu.
export function ActionSlot() {
  return <span className="size-7 shrink-0" aria-hidden />;
}

export function KeybindingListRow({
  row,
  allRows,
  variables,
  isSaving,
  nested = false,
  onSave,
  onReset,
  onRemove,
}: {
  row: KeybindingRow;
  allRows: ReadonlyArray<KeybindingRow>;
  variables: ReadonlyArray<WhenVariableOption>;
  isSaving: boolean;
  nested?: boolean;
  onSave: (input: ServerUpsertKeybindingInput) => void;
  onReset: (row: KeybindingRow) => void;
  onRemove: (row: KeybindingRow) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useReducer(keybindingRowDraftReducer, row, createKeybindingRowDraft);
  const { keyDraft, whenDraft, isRecording, isWhenDraftValid } = draft;
  const title = commandLabel(row.command);
  const whenDraftExpression = whenAstToExpression(whenDraft);
  const isDirty = keyDraft !== row.key || whenDraftExpression !== row.when;
  const canReset = row.source === "Custom" && row.defaultKey !== null;
  const canRemove = row.source !== "Default";

  const conflictLabels = keybindingConflictLabels(allRows, {
    rowId: row.id,
    key: keyDraft,
    when: whenDraftExpression,
    ...(isDirty ? {} : { order: row.order }),
  });

  const save = () => {
    onSave({
      command: row.command,
      key: keyDraft,
      when: whenDraftExpression.trim().length > 0 ? whenDraftExpression : undefined,
      replace: rowKeybindingTarget(row),
    });
  };

  return (
    <div
      className={cn(
        "group/row flex min-h-11 items-center gap-3 rounded-lg border border-transparent py-1.5 pr-3 sm:pr-4",
        row.source === "Custom" &&
          "border-primary/20 border-l-2 border-l-primary bg-primary/[0.045]",
        row.source === "Default" && "hover:bg-muted/30",
        nested ? "pl-9 sm:pl-10" : "pl-3 sm:pl-4",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5 sm:flex-row sm:items-center sm:gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <Tooltip>
            <TooltipTrigger
              render={<span className="truncate text-13px text-foreground" />}
              delay={400}
            >
              {title}
            </TooltipTrigger>
            <TooltipPopup side="top" variant="diagnostics-mono">
              {row.command}
            </TooltipPopup>
          </Tooltip>
          <SourceBadge source={row.source} />
        </span>
        <ConditionPopover
          commandTitle={title}
          whenDraft={whenDraft}
          variables={variables}
          onChange={(nextWhenDraft) => setDraft({ whenDraft: nextWhenDraft })}
          onValidityChange={(nextIsValid) => setDraft({ isWhenDraftValid: nextIsValid })}
        />
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <KeybindingConflictWarning labels={conflictLabels} />
        <ShortcutRecorder
          commandTitle={title}
          value={keyDraft}
          resetKey={row.key}
          isRecording={isRecording}
          hasConflict={conflictLabels.length > 0}
          onRecordingChange={(recording) => setDraft({ isRecording: recording })}
          onChange={(key) => setDraft({ keyDraft: key })}
        />
        {isDirty ? (
          <>
            <Button
              size="compact"
              disabled={isSaving || keyDraft.trim().length === 0 || !isWhenDraftValid}
              onClick={save}
            >
              {isSaving ? t("Saving") : t("Save")}
            </Button>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="keybinding-action"
                    size="icon-sm"
                    className="size-7 sm:size-7"
                    disabled={isSaving}
                    aria-label={t("Discard changes to {command}", { command: title })}
                    onClick={() => setDraft(createKeybindingRowDraft(row))}
                  />
                }
              >
                <XIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="top">{t("Discard changes")}</TooltipPopup>
            </Tooltip>
          </>
        ) : canReset || canRemove ? (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  type="button"
                  variant="keybinding-action"
                  size="icon-sm"
                  className="size-7 sm:size-7"
                  disabled={isSaving}
                  aria-label={t("More actions for {command}", { command: title })}
                />
              }
            >
              <EllipsisIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end" className="min-w-40">
              {canReset ? (
                <MenuItem disabled={isSaving} onClick={() => onReset(row)}>
                  {t("Reset to default")}
                </MenuItem>
              ) : null}
              {canRemove ? (
                <MenuItem variant="destructive" disabled={isSaving} onClick={() => onRemove(row)}>
                  {t("Remove shortcut")}
                </MenuItem>
              ) : null}
            </MenuPopup>
          </Menu>
        ) : (
          <ActionSlot />
        )}
      </div>
    </div>
  );
}

export function KeybindingSeriesItem({
  series,
  expanded,
  onExpandedChange,
  children,
}: {
  series: KeybindingSeries;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const panelId = useId();
  const customized = series.rows.filter((row) => row.source === "Custom").length;
  const conflictLabels = [...new Set(series.rows.flatMap((row) => row.conflicts))].toSorted();
  const firstRow = series.rows[0];

  const condition =
    series.when && firstRow ? describeWhenExpression(firstRow.binding.whenAst) : null;

  return (
    <div>
      <div className="flex min-h-11 items-center gap-3 py-1.5 pr-3 pl-3 sm:pr-4 sm:pl-4">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => onExpandedChange(!expanded)}
          className="-ml-1 flex min-w-0 flex-1 items-center gap-2 rounded-md py-0.5 pl-1 text-left outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/24"
        >
          <ChevronRightIcon
            className={cn("size-3.5 shrink-0 text-muted-foreground", expanded && "rotate-90")}
          />
          <span className="truncate text-13px text-foreground">{series.title}</span>
          {customized > 0 ? (
            <Badge variant="keybinding-custom" size="sm">
              {t("{count} custom", { count: customized })}
            </Badge>
          ) : null}
          {condition ? (
            <span className="hidden truncate text-12px text-muted-foreground sm:inline">
              {condition}
            </span>
          ) : null}
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          <KeybindingConflictWarning labels={conflictLabels} />
          <span className="inline-flex h-7 items-center px-1">
            {series.rangeKey ? (
              <KeyCaps value={series.rangeKey} />
            ) : (
              <span className="text-12px text-muted-foreground">
                {t("{count} shortcuts", { count: series.rows.length })}
              </span>
            )}
          </span>
          <ActionSlot />
        </div>
      </div>
      {expanded ? (
        <div
          id={panelId}
          className="divide-y divide-border/40 border-t border-border/50 bg-muted/20"
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
