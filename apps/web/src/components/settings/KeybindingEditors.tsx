import {
  type KeybindingCommand,
  type KeybindingWhenNode,
  type ServerRemoveKeybindingInput,
  type ServerUpsertKeybindingInput,
} from "@akeru/contracts";
import { PlusIcon, TriangleAlertIcon } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useReducer, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { KeybindingConflictWarning, KeyCaps, spokenKeybinding } from "./KeybindingPresentation";
import {
  type KeybindingCommandOption,
  type KeybindingRow,
  commandLabel,
  KEYBINDING_GROUPS,
  keybindingConflictLabels,
  keybindingFromKeyboardEvent,
  keybindingGroupForCommand,
} from "./KeybindingsSettings.logic";
import {
  type WhenVariableOption,
  describeWhenExpression,
  unknownWhenVariables,
  whenAstToExpression,
} from "./KeybindingWhen.logic";
import { WhenExpressionBuilder } from "./KeybindingWhenEditor";

export type KeybindingRowDraftState = {
  keyDraft: string;
  whenDraft: KeybindingWhenNode | undefined;
  isRecording: boolean;
  isWhenDraftValid: boolean;
};

export function createKeybindingRowDraft(row: KeybindingRow): KeybindingRowDraftState {
  return {
    keyDraft: row.key,
    whenDraft: row.binding.whenAst,
    isRecording: false,
    isWhenDraftValid: true,
  };
}

export const EMPTY_KEYBINDING_DRAFT: KeybindingRowDraftState = {
  keyDraft: "",
  whenDraft: undefined,
  isRecording: false,
  isWhenDraftValid: true,
};

export function keybindingRowDraftReducer(
  state: KeybindingRowDraftState,
  patch: Partial<KeybindingRowDraftState>,
): KeybindingRowDraftState {
  return { ...state, ...patch };
}

export function rowKeybindingTarget(row: KeybindingRow): ServerRemoveKeybindingInput {
  return {
    command: row.command,
    key: row.key,
    ...(row.when.trim().length > 0 ? { when: row.when } : {}),
  };
}

/**
 * Shows the current shortcut as key caps and swaps to a capture field while
 * recording. Escape restores `resetKey`; Tab leaves without changing it.
 */
export function ShortcutRecorder({
  commandTitle,
  value,
  resetKey,
  isRecording,
  hasConflict,
  onRecordingChange,
  onChange,
}: {
  commandTitle: string;
  value: string;
  resetKey: string;
  isRecording: boolean;
  hasConflict: boolean;
  onRecordingChange: (recording: boolean) => void;
  onChange: (key: string) => void;
}) {
  const { t } = useI18n();
  const hintId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);

  useEffect(() => {
    if (isRecording || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    buttonRef.current?.focus();
  }, [isRecording]);

  const captureKeybinding = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Tab") return;
    event.preventDefault();

    if (event.key === "Escape") {
      restoreFocusRef.current = true;
      onChange(resetKey);
      onRecordingChange(false);

      return;
    }

    const next = keybindingFromKeyboardEvent(event.nativeEvent, navigator.platform);

    if (!next) return;
    restoreFocusRef.current = true;
    onChange(next);
    onRecordingChange(false);
  };

  if (isRecording) {
    return (
      <>
        <Input
          data-keybinding-capture=""
          autoFocus
          readOnly
          aria-label={t("Record shortcut for {command}", { command: commandTitle })}
          aria-describedby={hintId}
          value=""
          placeholder={t("Press keys…")}
          size="compact"
          variant="keybinding-capture"
          className="w-36"
          onBlur={() => onRecordingChange(false)}
          onKeyDown={captureKeybinding}
        />
        <span id={hintId} className="sr-only">
          {t("Press the new key combination with at least one modifier. Escape cancels.")}
        </span>
      </>
    );
  }

  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={() => onRecordingChange(true)}
      aria-label={
        value
          ? t("Change shortcut for {command}, currently {keys}", {
              command: commandTitle,
              keys: spokenKeybinding(value),
            })
          : t("Record shortcut for {command}", { command: commandTitle })
      }
      className={cn(
        "inline-flex h-7 min-w-16 items-center justify-end rounded-md border border-transparent px-1 outline-none transition-colors hover:border-border/70 hover:bg-accent/50 focus-visible:border-foreground/30 focus-visible:ring-3 focus-visible:ring-ring/24",
        hasConflict && "border-warning/40 bg-warning/5",
      )}
    >
      {value ? (
        <KeyCaps value={value} />
      ) : (
        <span className="px-1 text-12px text-muted-foreground">{t("Record shortcut")}</span>
      )}
    </button>
  );
}

/**
 * Condition summary that opens the when-clause builder. Empty conditions stay
 * hidden until the row is hovered or the trigger is focused.
 */
export function ConditionPopover({
  commandTitle,
  whenDraft,
  variables,
  alwaysVisible = false,
  onChange,
  onValidityChange,
}: {
  commandTitle: string;
  whenDraft: KeybindingWhenNode | undefined;
  variables: ReadonlyArray<WhenVariableOption>;
  alwaysVisible?: boolean;
  onChange: (value: KeybindingWhenNode | undefined) => void;
  onValidityChange: (valid: boolean) => void;
}) {
  const { t } = useI18n();
  const description = describeWhenExpression(whenDraft);
  const expression = whenAstToExpression(whenDraft);
  const unknownIdentifiers = unknownWhenVariables(whenDraft);
  const isRawExpression = description === expression;

  return (
    <Popover>
      <PopoverTrigger
        variant="keybinding-condition"
        revealOnHover={!description && !alwaysVisible}
        aria-label={
          description
            ? t("Edit condition for {command}: {condition}", {
                command: commandTitle,
                condition: description,
              })
            : t("Add condition for {command}", { command: commandTitle })
        }
      >
        {description ? (
          <span className={cn("truncate", isRawExpression && "font-mono text-11px")}>
            {description}
          </span>
        ) : (
          <>
            <PlusIcon className="size-3 shrink-0" />
            <span>{t("Condition")}</span>
          </>
        )}
        {unknownIdentifiers.length > 0 ? (
          <TriangleAlertIcon
            className="size-3 shrink-0 text-warning"
            aria-label={t("Unknown condition")}
          />
        ) : null}
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6}>
        <WhenExpressionBuilder
          value={whenDraft}
          variables={variables}
          onChange={onChange}
          onValidityChange={onValidityChange}
        />
      </PopoverContent>
    </Popover>
  );
}

export function NewKeybindingCard({
  commandOptions,
  allRows,
  variables,
  isSaving,
  onSave,
  onCancel,
}: {
  commandOptions: ReadonlyArray<KeybindingCommandOption>;
  allRows: ReadonlyArray<KeybindingRow>;
  variables: ReadonlyArray<WhenVariableOption>;
  isSaving: boolean;
  onSave: (input: ServerUpsertKeybindingInput) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [commandDraft, setCommandDraft] = useState<KeybindingCommand | "">("");
  const [draft, setDraft] = useReducer(keybindingRowDraftReducer, EMPTY_KEYBINDING_DRAFT);
  const { keyDraft, whenDraft, isRecording, isWhenDraftValid } = draft;
  const whenDraftExpression = whenAstToExpression(whenDraft);

  const conflictLabels = keybindingConflictLabels(allRows, {
    rowId: "new",
    key: keyDraft,
    when: whenDraftExpression,
  });

  const commandTitle = commandDraft ? commandLabel(commandDraft) : t("new shortcut");

  const optionGroups = KEYBINDING_GROUPS.map((group) => ({
    ...group,
    commands: commandOptions.filter((command) => keybindingGroupForCommand(command) === group.id),
  })).filter((group) => group.commands.length > 0);

  const save = () => {
    if (!commandDraft) return;
    onSave({
      command: commandDraft,
      key: keyDraft,
      ...(whenDraftExpression.trim().length > 0 ? { when: whenDraftExpression } : {}),
    });
  };

  return (
    <div
      role="group"
      aria-label={t("New shortcut")}
      className="rounded-xl border border-border/70 bg-settings-surface"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 sm:px-4">
        <Select
          value={commandDraft}
          onValueChange={(value) => {
            const command = commandOptions.find((command) => command === value);

            if (command) setCommandDraft(command);
          }}
        >
          <SelectTrigger
            size="compact"
            className="w-full sm:w-60"
            aria-label={t("Command")}
            autoFocus
          >
            <SelectValue placeholder={t("Choose a command")} />
          </SelectTrigger>
          <SelectContent
            alignItemWithTrigger={false}
            matchTriggerWidth={false}
            className="max-h-80 w-fit min-w-60"
          >
            {optionGroups.map((group) => (
              <SelectGroup key={group.id}>
                <SelectGroupLabel>{group.title}</SelectGroupLabel>
                {group.commands.map((command) => (
                  <SelectItem
                    key={command}
                    value={command}
                    size="keybinding-command"
                    className="min-h-7 w-full"
                  >
                    <span className="truncate">{commandLabel(command)}</span>
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
        <ConditionPopover
          commandTitle={commandTitle}
          whenDraft={whenDraft}
          variables={variables}
          alwaysVisible
          onChange={(nextWhenDraft) => setDraft({ whenDraft: nextWhenDraft })}
          onValidityChange={(nextIsValid) => setDraft({ isWhenDraftValid: nextIsValid })}
        />
        <div className="ml-auto flex items-center gap-1.5">
          <KeybindingConflictWarning labels={conflictLabels} />
          <ShortcutRecorder
            commandTitle={commandTitle}
            value={keyDraft}
            resetKey=""
            isRecording={isRecording}
            hasConflict={conflictLabels.length > 0}
            onRecordingChange={(recording) => setDraft({ isRecording: recording })}
            onChange={(key) => setDraft({ keyDraft: key })}
          />
          <Button
            size="compact"
            disabled={
              isSaving || !commandDraft || keyDraft.trim().length === 0 || !isWhenDraftValid
            }
            onClick={save}
          >
            {isSaving ? t("Saving") : t("Add")}
          </Button>
          <Button
            type="button"
            size="compact"
            variant="ghost"
            disabled={isSaving}
            onClick={onCancel}
          >
            {t("Cancel")}
          </Button>
        </div>
      </div>
    </div>
  );
}
