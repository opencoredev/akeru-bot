import {
  ChevronRightIcon,
  CircleXIcon,
  EllipsisIcon,
  FileJsonIcon,
  InfoIcon,
  MinusIcon,
  PlusIcon,
  SearchIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  type KeybindingCommand,
  type KeybindingWhenNode,
  type ServerRemoveKeybindingInput,
  type ServerUpsertKeybindingInput,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import type { MessageKey } from "@t3tools/client-runtime/i18n";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { isElectron } from "../../env";
import { useOpenInPreferredEditor } from "../../editorPreferences";
import { cn } from "../../lib/utils";
import {
  primaryServerAvailableEditorsAtom,
  primaryServerKeybindingsAtom,
  primaryServerKeybindingsConfigPathAtom,
  serverEnvironment,
} from "../../state/server";
import { usePrimaryEnvironment } from "../../state/environments";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Kbd, KbdGroup } from "../ui/kbd";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
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
import { Toggle } from "../ui/toggle";
import { Toggle as ToggleGroupItem, ToggleGroup } from "../ui/toggle-group";
import { toastManager } from "../ui/toast";
import {
  buildKeybindingCommandOptions,
  buildKeybindingGroups,
  buildKeybindingRows,
  buildWhenVariableOptions,
  commandLabel,
  DEFAULT_WHEN_VARIABLE,
  describeWhenExpression,
  isKnownWhenVariable,
  KEYBINDING_GROUPS,
  keybindingConflictLabels,
  keybindingDisplayParts,
  keybindingFromKeyboardEvent,
  keybindingGroupForCommand,
  parseWhenExpressionDraft,
  summarizeKeybindings,
  type KeybindingCommandOption,
  type KeybindingFilter,
  type KeybindingRow,
  type KeybindingSeries,
  type WhenVariableOption,
  unknownWhenVariables,
  whenAstToExpression,
} from "./KeybindingsSettings.logic";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useAtomCommand } from "../../state/use-atom-command";
import { useI18n } from "../../i18n";

type Translate = ReturnType<typeof useI18n>["t"];

/** Renders a keybinding string as one key cap per modifier and key. */
function KeyCaps({ value, className }: { value: string; className?: string }) {
  const parts = keybindingDisplayParts(value, navigator.platform);
  return (
    <KbdGroup className={cn("gap-0.5", className)}>
      {parts.map((part) => (
        <Kbd
          key={part}
          className="h-5.5 min-w-5.5 rounded-[5px] border border-border/80 bg-background px-1.5 text-[11px] text-foreground shadow-xs/5"
        >
          {part}
        </Kbd>
      ))}
    </KbdGroup>
  );
}

function spokenKeybinding(value: string): string {
  return keybindingDisplayParts(value, navigator.platform).join(" ");
}

type BooleanOperator = "and" | "or";

function flattenWhenChildren(
  node: KeybindingWhenNode,
  operator: BooleanOperator,
): KeybindingWhenNode[] {
  if (node.type !== operator) return [node];
  return [
    ...flattenWhenChildren(node.left, operator),
    ...flattenWhenChildren(node.right, operator),
  ];
}

function buildWhenExpressionGroup(
  children: readonly KeybindingWhenNode[],
  operator: BooleanOperator,
): KeybindingWhenNode | undefined {
  const first = children[0];
  if (!first) return undefined;
  return children.slice(1).reduce<KeybindingWhenNode>(
    (left, right) => ({
      type: operator,
      left,
      right,
    }),
    first,
  );
}

function conditionParts(node: KeybindingWhenNode): { identifier: string; negated: boolean } | null {
  if (node.type === "identifier") return { identifier: node.name, negated: false };
  if (node.type === "not" && node.node.type === "identifier") {
    return { identifier: node.node.name, negated: true };
  }
  return null;
}

function setConditionIdentifier(node: KeybindingWhenNode, identifier: string): KeybindingWhenNode {
  const parts = conditionParts(node);
  if (!parts) return node;
  const next: KeybindingWhenNode = { type: "identifier", name: identifier };
  return parts.negated ? { type: "not", node: next } : next;
}

function setConditionNegated(node: KeybindingWhenNode, negated: boolean): KeybindingWhenNode {
  const parts = conditionParts(node);
  if (!parts) return negated ? { type: "not", node } : node;
  const identifier: KeybindingWhenNode = { type: "identifier", name: parts.identifier };
  return negated ? { type: "not", node: identifier } : identifier;
}

function defaultWhenCondition(): KeybindingWhenNode {
  return { type: "identifier", name: DEFAULT_WHEN_VARIABLE };
}

function defaultWhenGroup(operator: BooleanOperator = "and"): KeybindingWhenNode {
  return {
    type: operator,
    left: defaultWhenCondition(),
    right: { type: "not", node: defaultWhenCondition() },
  };
}

function UnknownWhenVariableWarning({
  identifiers,
  focusable = true,
}: {
  identifiers: ReadonlyArray<string>;
  focusable?: boolean;
}) {
  const { t } = useI18n();
  if (identifiers.length === 0) return null;
  const label =
    identifiers.length === 1
      ? t("Unknown condition: {name}", { name: identifiers[0] ?? "" })
      : t("Unknown conditions: {names}", { names: identifiers.join(", ") });

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={focusable ? 0 : undefined}
            aria-label={label}
            className="inline-flex size-4.5 shrink-0 items-center justify-center rounded-sm text-warning outline-none transition-colors hover:bg-warning/10 focus-visible:ring-[3px] focus-visible:ring-warning/25"
          >
            <TriangleAlertIcon className="size-3.5" />
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-72 whitespace-normal leading-relaxed">
        {t(
          "Akeru Bot does not recognize this condition yet. It can still be saved, but it may not match unless the runtime provides it.",
        )}
      </TooltipPopup>
    </Tooltip>
  );
}

function conflictDescription(labels: ReadonlyArray<string>, t: Translate): string {
  const listed = labels.slice(0, 3).join(", ");
  return labels.length > 3
    ? t("Same keys as {labels}, and more.", { labels: listed })
    : t("Same keys as {labels}.", { labels: listed });
}

function KeybindingConflictWarning({ labels }: { labels: ReadonlyArray<string> }) {
  const { t } = useI18n();
  if (labels.length === 0) return null;
  const description = conflictDescription(labels, t);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            role="img"
            aria-label={t("Conflict. {description}", { description })}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-warning outline-none hover:bg-warning/10 focus-visible:ring-[3px] focus-visible:ring-warning/25"
          >
            <TriangleAlertIcon className="size-3.5" />
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-72 whitespace-normal leading-relaxed">
        {t("{description} Only the one defined last will run.", { description })}
      </TooltipPopup>
    </Tooltip>
  );
}

function WhenVariableSelect({
  value,
  variables,
  unknownIdentifiers,
  onChange,
}: {
  value: string;
  variables: ReadonlyArray<WhenVariableOption>;
  unknownIdentifiers?: ReadonlyArray<string>;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const selected = variables.find((option) => option === value);
  const options =
    selected || variables.some((option) => option === value) ? variables : [value, ...variables];

  return (
    <Select value={value} onValueChange={(nextValue) => nextValue && onChange(nextValue)}>
      <SelectTrigger size="compact" className="min-w-0 flex-1 font-mono">
        <SelectValue placeholder={t("Condition")} className="leading-7" />
        {unknownIdentifiers && unknownIdentifiers.length > 0 ? (
          <UnknownWhenVariableWarning identifiers={unknownIdentifiers} focusable={false} />
        ) : null}
      </SelectTrigger>
      <SelectContent
        alignItemWithTrigger={false}
        matchTriggerWidth={false}
        popupClassName="w-fit"
        className="max-h-72 w-fit min-w-44"
      >
        {options.map((option) => (
          <SelectItem
            key={option}
            value={option}
            className="min-h-7 w-full py-1 font-mono text-[12px]"
          >
            <span className="truncate">{option}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function WhenExpressionNodeEditor({
  node,
  variables,
  depth = 0,
  onChange,
  onRemove,
}: {
  node: KeybindingWhenNode;
  variables: ReadonlyArray<WhenVariableOption>;
  depth?: number;
  onChange: (node: KeybindingWhenNode) => void;
  onRemove?: () => void;
}) {
  const { t } = useI18n();
  const condition = conditionParts(node);

  if (condition) {
    const unknownIdentifiers = isKnownWhenVariable(condition.identifier)
      ? []
      : [condition.identifier];

    return (
      <div className="flex items-center gap-2 rounded-md border border-border/70 bg-background/60 px-2 py-2">
        <Toggle
          pressed={condition.negated}
          onPressedChange={(pressed) => onChange(setConditionNegated(node, pressed))}
          aria-label={t("Negate {name}", { name: condition.identifier })}
          variant="outline"
          size="compact"
          className="min-w-10"
        >
          {t("Not")}
        </Toggle>
        <WhenVariableSelect
          value={condition.identifier}
          variables={variables}
          unknownIdentifiers={unknownIdentifiers}
          onChange={(value) => onChange(setConditionIdentifier(node, value))}
        />
        {onRemove ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7"
            aria-label={t("Remove condition")}
            onClick={onRemove}
          >
            <MinusIcon className="size-3.5" />
          </Button>
        ) : null}
      </div>
    );
  }

  if (node.type === "not") {
    return (
      <div
        className={cn(
          "space-y-2 rounded-lg border border-border/70 bg-muted/20 p-2",
          depth > 0 && "border-border/50 bg-background/50",
        )}
      >
        <div className="flex items-center gap-2">
          <Toggle
            pressed
            onPressedChange={(pressed) => onChange(pressed ? node : node.node)}
            aria-label={t("Negate group")}
            variant="outline"
            size="compact"
            className="min-w-10"
          >
            {t("Not")}
          </Toggle>
          {onRemove ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="ml-auto size-7"
              aria-label={t("Remove negated group")}
              onClick={onRemove}
            >
              <MinusIcon className="size-3.5" />
            </Button>
          ) : null}
        </div>
        <div className="relative pl-4">
          <span className="absolute top-0 bottom-0 left-1.5 w-px bg-border/70" aria-hidden />
          <span className="absolute top-4 left-1.5 h-px w-2.5 bg-border/70" aria-hidden />
          <WhenExpressionNodeEditor
            node={node.node}
            variables={variables}
            depth={depth + 1}
            onChange={(next) => onChange({ type: "not", node: next })}
          />
        </div>
      </div>
    );
  }

  const operator: BooleanOperator = node.type === "or" ? "or" : "and";
  const children = flattenWhenChildren(node, operator);
  const childKeyCounts = new Map<string, number>();
  const childEntries = children.map((child) => {
    const baseKey = `${child.type}-${whenAstToExpression(child)}`;
    const count = childKeyCounts.get(baseKey) ?? 0;
    childKeyCounts.set(baseKey, count + 1);
    return { child, key: count === 0 ? baseKey : `${baseKey}-${count}` };
  });

  const updateChild = (target: KeybindingWhenNode, next: KeybindingWhenNode) => {
    let didUpdate = false;
    const nextChildren = children.map((child) => {
      if (!didUpdate && child === target) {
        didUpdate = true;
        return next;
      }
      return child;
    });
    const nextNode = buildWhenExpressionGroup(nextChildren, operator);
    if (nextNode) onChange(nextNode);
  };

  const removeChild = (target: KeybindingWhenNode) => {
    let didRemove = false;
    const nextChildren = children.filter((child) => {
      if (!didRemove && child === target) {
        didRemove = true;
        return false;
      }
      return true;
    });
    const nextNode = buildWhenExpressionGroup(nextChildren, operator);
    if (nextNode) {
      onChange(nextNode);
    } else {
      onChange(defaultWhenCondition());
    }
  };

  const setOperator = (nextOperator: BooleanOperator) => {
    if (nextOperator === operator) return;
    const nextNode = buildWhenExpressionGroup(children, nextOperator);
    if (nextNode) onChange(nextNode);
  };

  const addCondition = () => {
    const nextNode = buildWhenExpressionGroup([...children, defaultWhenCondition()], operator);
    if (nextNode) onChange(nextNode);
  };

  const addGroup = () => {
    const nestedOperator: BooleanOperator = operator === "and" ? "or" : "and";
    const group: KeybindingWhenNode = {
      type: nestedOperator,
      left: defaultWhenCondition(),
      right: { type: "not", node: defaultWhenCondition() },
    };
    const nextNode = buildWhenExpressionGroup([...children, group], operator);
    if (nextNode) onChange(nextNode);
  };

  return (
    <div
      className={cn(
        "space-y-2 rounded-lg border border-border/60 bg-muted/10 p-2",
        depth > 0 && "border-border/70 bg-background/55",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Select value={operator} onValueChange={(value) => setOperator(value as BooleanOperator)}>
          <SelectTrigger size="compact" className="w-24">
            <SelectValue />
          </SelectTrigger>
          <SelectContent
            alignItemWithTrigger={false}
            matchTriggerWidth={false}
            popupClassName="w-fit"
            className="w-fit min-w-24"
          >
            <SelectItem value="and" className="min-h-7 py-1 font-mono text-[12px]">
              and
            </SelectItem>
            <SelectItem value="or" className="min-h-7 py-1 font-mono text-[12px]">
              or
            </SelectItem>
          </SelectContent>
        </Select>
        <Button type="button" variant="outline" size="compact" onClick={addCondition}>
          <PlusIcon className="size-3.5" />
          {t("Condition")}
        </Button>
        <Button type="button" variant="outline" size="compact" onClick={addGroup}>
          <PlusIcon className="size-3.5" />
          Group
        </Button>
        {onRemove ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="ml-auto size-7"
            aria-label={t("Remove group")}
            onClick={onRemove}
          >
            <MinusIcon className="size-3.5" />
          </Button>
        ) : null}
      </div>
      <div className="space-y-2">
        {childEntries.map(({ child, key }) => (
          <div key={key} className="relative pl-4">
            <span
              className={cn(
                "absolute top-0 bottom-0 left-1.5 w-px",
                depth === 0 ? "bg-border" : "bg-border/70",
              )}
              aria-hidden
            />
            <span
              className={cn(
                "absolute top-4 left-1.5 h-px w-2.5",
                depth === 0 ? "bg-border" : "bg-border/70",
              )}
              aria-hidden
            />
            <WhenExpressionNodeEditor
              node={child}
              variables={variables}
              depth={depth + 1}
              onChange={(next) => updateChild(child, next)}
              onRemove={() => removeChild(child)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function WhenExpressionBuilder({
  value,
  variables,
  onChange,
  onValidityChange,
}: {
  value: KeybindingWhenNode | undefined;
  variables: ReadonlyArray<WhenVariableOption>;
  onChange: (value: KeybindingWhenNode | undefined) => void;
  onValidityChange?: (valid: boolean) => void;
}) {
  const { t } = useI18n();
  const expression = whenAstToExpression(value);
  const [expressionDraft, setExpressionDraft] = useState(expression);
  const parseResult = useMemo(() => parseWhenExpressionDraft(expressionDraft), [expressionDraft]);
  const parseError = parseResult.ok ? null : parseResult.message;
  const unknownIdentifiers = parseResult.ok ? unknownWhenVariables(parseResult.value) : [];

  const updateExpressionDraft = (nextExpression: string) => {
    setExpressionDraft(nextExpression);
    const nextResult = parseWhenExpressionDraft(nextExpression);
    onValidityChange?.(nextResult.ok);
    if (nextResult.ok) {
      onChange(nextResult.value);
    }
  };

  const updateExpressionValue = (nextValue: KeybindingWhenNode | undefined) => {
    setExpressionDraft(whenAstToExpression(nextValue));
    onValidityChange?.(true);
    onChange(nextValue);
  };

  const addRootCondition = () => {
    if (!value) {
      updateExpressionValue(defaultWhenCondition());
      return;
    }
    updateExpressionValue({ type: "and", left: value, right: defaultWhenCondition() });
  };

  const addRootGroup = () => {
    const group = defaultWhenGroup("or");
    if (!value) {
      updateExpressionValue(group);
      return;
    }
    updateExpressionValue({ type: "and", left: value, right: group });
  };

  return (
    <div className="w-[min(34rem,calc(100vw-2rem))] space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">{t("When")}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button type="button" variant="outline" size="compact" onClick={addRootCondition}>
            <PlusIcon className="size-3.5" />
            {t("Condition")}
          </Button>
          <Button type="button" variant="outline" size="compact" onClick={addRootGroup}>
            <PlusIcon className="size-3.5" />
            Group
          </Button>
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="relative">
          <Input
            value={expressionDraft}
            onChange={(event) => updateExpressionDraft(event.currentTarget.value)}
            placeholder={t("Always")}
            aria-invalid={Boolean(parseError)}
            aria-label={t("When expression")}
            className={cn(
              "h-7 rounded-md font-mono text-[12px] leading-7 sm:h-7 sm:leading-7",
              unknownIdentifiers.length > 0 && "pr-9",
              parseError && "border-destructive/70 focus-visible:border-destructive",
            )}
          />
          {unknownIdentifiers.length > 0 ? (
            <span className="absolute inset-y-0 right-2 flex items-center">
              <UnknownWhenVariableWarning identifiers={unknownIdentifiers} />
            </span>
          ) : null}
        </div>
        {parseError ? (
          <div className="flex items-center gap-1.5 text-[11px] text-destructive">
            <CircleXIcon className="size-3.5" />
            {parseError}
          </div>
        ) : null}
      </div>

      <div className="relative">
        {value ? (
          <WhenExpressionNodeEditor
            node={value}
            variables={variables}
            onChange={updateExpressionValue}
            onRemove={() => updateExpressionValue(undefined)}
          />
        ) : (
          <div className="rounded-md border border-dashed border-border/80 bg-muted/15 p-3">
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="compact" onClick={addRootCondition}>
                <PlusIcon className="size-3.5" />
                {t("Condition")}
              </Button>
              <Button type="button" variant="outline" size="compact" onClick={addRootGroup}>
                <PlusIcon className="size-3.5" />
                Group
              </Button>
            </div>
          </div>
        )}
        {parseError ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg border border-destructive/30 bg-background/75 p-4 text-center text-xs text-destructive backdrop-blur-[1px]">
            {t("Fix the expression above to continue editing visually.")}
          </div>
        ) : null}
      </div>
    </div>
  );
}

type KeybindingRowDraftState = {
  keyDraft: string;
  whenDraft: KeybindingWhenNode | undefined;
  isRecording: boolean;
  isWhenDraftValid: boolean;
};

function createKeybindingRowDraft(row: KeybindingRow): KeybindingRowDraftState {
  return {
    keyDraft: row.key,
    whenDraft: row.binding.whenAst,
    isRecording: false,
    isWhenDraftValid: true,
  };
}

const EMPTY_KEYBINDING_DRAFT: KeybindingRowDraftState = {
  keyDraft: "",
  whenDraft: undefined,
  isRecording: false,
  isWhenDraftValid: true,
};

function keybindingRowDraftReducer(
  state: KeybindingRowDraftState,
  patch: Partial<KeybindingRowDraftState>,
): KeybindingRowDraftState {
  return { ...state, ...patch };
}

function rowKeybindingTarget(row: KeybindingRow): ServerRemoveKeybindingInput {
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
function ShortcutRecorder({
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
          className="w-36 border-ring/60 font-mono ring-[3px] ring-ring/15"
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
        "inline-flex h-7 min-w-16 items-center justify-end rounded-md border border-transparent px-1 outline-none transition-colors hover:border-border/70 hover:bg-accent/50 focus-visible:border-foreground/30 focus-visible:ring-[3px] focus-visible:ring-ring/24",
        hasConflict && "border-warning/40 bg-warning/5",
      )}
    >
      {value ? (
        <KeyCaps value={value} />
      ) : (
        <span className="px-1 text-[12px] text-muted-foreground">{t("Record shortcut")}</span>
      )}
    </button>
  );
}

/**
 * Condition summary that opens the when-clause builder. Empty conditions stay
 * hidden until the row is hovered or the trigger is focused.
 */
function ConditionPopover({
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
        className={cn(
          "inline-flex h-6 max-w-full min-w-0 items-center gap-1 rounded-md px-1.5 text-left text-[12px] text-muted-foreground outline-none transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/24 data-[popup-open]:bg-accent/60 data-[popup-open]:text-foreground",
          !description &&
            !alwaysVisible &&
            "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 data-[popup-open]:opacity-100",
        )}
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
          <span className={cn("truncate", isRawExpression && "font-mono text-[11px]")}>
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

function SourceBadge({ source }: { source: KeybindingRow["source"] }) {
  const { t } = useI18n();
  if (source === "Default") {
    return (
      <Badge variant="outline" size="sm" className="font-normal text-muted-foreground/70">
        {t("Default")}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" size="sm" className="font-normal text-muted-foreground">
      {t("Custom")}
    </Badge>
  );
}

// Keeps shortcut chips aligned when a row has no actions menu.
function ActionSlot() {
  return <span className="size-7 shrink-0" aria-hidden />;
}

function KeybindingListRow({
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
              render={<span className="truncate text-[13px] text-foreground" />}
              delay={400}
            >
              {title}
            </TooltipTrigger>
            <TooltipPopup side="top" className="font-mono text-[11px]">
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
                    variant="ghost"
                    size="icon-sm"
                    className="size-7 text-muted-foreground hover:text-foreground sm:size-7"
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
                  variant="ghost"
                  size="icon-sm"
                  className="size-7 text-muted-foreground hover:text-foreground sm:size-7"
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

function KeybindingSeriesItem({
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
          className="-ml-1 flex min-w-0 flex-1 items-center gap-2 rounded-md py-0.5 pl-1 text-left outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/24"
        >
          <ChevronRightIcon
            className={cn("size-3.5 shrink-0 text-muted-foreground", expanded && "rotate-90")}
          />
          <span className="truncate text-[13px] text-foreground">{series.title}</span>
          {customized > 0 ? (
            <Badge variant="outline" size="sm" className="font-normal text-muted-foreground">
              {t("{count} custom", { count: customized })}
            </Badge>
          ) : null}
          {condition ? (
            <span className="hidden truncate text-[12px] text-muted-foreground sm:inline">
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
              <span className="text-[12px] text-muted-foreground">
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

function NewKeybindingCard({
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
          onValueChange={(value) => setCommandDraft(value as KeybindingCommand)}
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
                    className="min-h-7 w-full py-1 text-[12px]"
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

const FILTER_LABELS: Readonly<Record<KeybindingFilter, MessageKey>> = {
  all: "All",
  customized: "Customized",
  conflicts: "Conflicts",
};

function isKeybindingFilter(value: unknown): value is KeybindingFilter {
  return value === "all" || value === "customized" || value === "conflicts";
}

function emptyStateMessage(filter: KeybindingFilter, query: string, t: Translate): string {
  if (query.trim().length > 0) return t("No shortcuts match “{query}”.", { query: query.trim() });
  if (filter === "customized") return t("You haven't changed any shortcuts yet.");
  if (filter === "conflicts") return t("No shortcuts share keys. Nothing to fix.");
  return t("No shortcuts yet.");
}

export function KeybindingsSettingsPanel() {
  const { t, plural } = useI18n();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const keybindingsConfigPath = useAtomValue(primaryServerKeybindingsConfigPathAtom);
  const availableEditors = useAtomValue(primaryServerAvailableEditorsAtom);
  const primaryEnvironment = usePrimaryEnvironment();
  const upsertKeybinding = useAtomCommand(serverEnvironment.upsertKeybinding, {
    reportFailure: false,
  });
  const removeKeybindingMutation = useAtomCommand(serverEnvironment.removeKeybinding, {
    reportFailure: false,
  });
  const openInPreferredEditor = useOpenInPreferredEditor(
    primaryEnvironment?.environmentId ?? null,
    availableEditors,
  );
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<KeybindingFilter>("all");
  const [seriesExpansion, setSeriesExpansion] = useState<Readonly<Record<string, boolean>>>({});
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [savingCommand, setSavingCommand] = useState<KeybindingCommand | null>(null);
  const [isAddingBinding, setIsAddingBinding] = useState(false);
  const allRows = useMemo(() => buildKeybindingRows(keybindings, ""), [keybindings]);
  const rows = useMemo(() => buildKeybindingRows(keybindings, query), [keybindings, query]);
  const summary = useMemo(() => summarizeKeybindings(allRows), [allRows]);
  const commandOptions = useMemo(() => buildKeybindingCommandOptions(keybindings), [keybindings]);
  const whenVariables = useMemo(() => buildWhenVariableOptions(), []);
  // Once the last conflict is fixed the Conflicts option disappears, so fall back to All.
  const visibleFilter: KeybindingFilter =
    filter === "conflicts" && summary.conflicts === 0 ? "all" : filter;
  const groups = useMemo(() => buildKeybindingGroups(rows, visibleFilter), [rows, visibleFilter]);
  // Narrowed views open numbered series so matching steps are visible.
  const seriesExpandedByDefault = visibleFilter !== "all" || query.trim().length > 0;

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      const isMod = event.metaKey || event.ctrlKey;
      if (!isMod || event.altKey || event.key.toLowerCase() !== "f") return;

      const target = event.target;
      if (
        target !== searchInputRef.current &&
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }

      event.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const openKeybindingsFile = useCallback(() => {
    if (!keybindingsConfigPath) return;
    void (async () => {
      const result = await openInPreferredEditor(keybindingsConfigPath);
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
        return;
      }
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        title: t("Unable to open keybindings file"),
        description:
          error instanceof Error ? error.message : t("The keybindings file was not opened."),
        type: "error",
      });
    })();
  }, [keybindingsConfigPath, openInPreferredEditor, t]);

  const saveKeybinding = useCallback(
    (input: ServerUpsertKeybindingInput) => {
      if (!primaryEnvironment) return;
      setSavingCommand(input.command);
      const payload: ServerUpsertKeybindingInput = {
        command: input.command,
        key: input.key.trim(),
        ...(input.when?.trim() ? { when: input.when.trim() } : {}),
        ...(input.replace ? { replace: input.replace } : {}),
      };
      void (async () => {
        const result = await upsertKeybinding({
          environmentId: primaryEnvironment.environmentId,
          input: payload,
        });
        setSavingCommand(null);
        if (result._tag === "Success") {
          setIsAddingBinding(false);
          return;
        }
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            title: t("Unable to save keybinding"),
            description:
              error instanceof Error ? error.message : t("The keybinding was not saved."),
            type: "error",
          });
        }
      })();
    },
    [primaryEnvironment, t, upsertKeybinding],
  );

  const removeKeybinding = useCallback(
    (row: KeybindingRow) => {
      if (!primaryEnvironment) return;
      setSavingCommand(row.command);
      void (async () => {
        const result = await removeKeybindingMutation({
          environmentId: primaryEnvironment.environmentId,
          input: rowKeybindingTarget(row),
        });
        setSavingCommand(null);
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            title: t("Unable to remove keybinding"),
            description:
              error instanceof Error ? error.message : t("The keybinding was not removed."),
            type: "error",
          });
        }
      })();
    },
    [primaryEnvironment, removeKeybindingMutation, t],
  );

  const resetKeybinding = useCallback(
    (row: KeybindingRow) => {
      if (!row.defaultKey) return;
      saveKeybinding({
        command: row.command,
        key: row.defaultKey,
        when: row.defaultWhen.trim().length > 0 ? row.defaultWhen : undefined,
        replace: {
          command: row.command,
          key: row.key,
          ...(row.when.trim().length > 0 ? { when: row.when } : {}),
        },
      });
    },
    [saveKeybinding],
  );

  const renderRow = (row: KeybindingRow, nested = false) => (
    <KeybindingListRow
      key={row.id}
      row={row}
      allRows={allRows}
      variables={whenVariables}
      isSaving={savingCommand === row.command}
      nested={nested}
      onSave={saveKeybinding}
      onReset={resetKeybinding}
      onRemove={removeKeybinding}
    />
  );

  return (
    <SettingsPageContainer>
      <SettingsSection
        {...searchableSetting("keybindings", t)}
        headerAction={
          <div className="flex items-center gap-1.5">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-micro"
                    variant="ghost-muted"
                    disabled={!keybindingsConfigPath}
                    onClick={openKeybindingsFile}
                    aria-label={t("Open keybindings.json")}
                  >
                    <FileJsonIcon className="size-3" />
                  </Button>
                }
              />
              <TooltipPopup side="top">{t("Open keybindings.json")}</TooltipPopup>
            </Tooltip>
            <Button
              type="button"
              size="compact"
              variant="outline"
              disabled={isAddingBinding}
              onClick={() => setIsAddingBinding(true)}
            >
              <PlusIcon className="size-3.5" />
              {t("Add shortcut")}
            </Button>
          </div>
        }
      >
        <div className="space-y-6">
          <div className="space-y-2">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative min-w-0 flex-1">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  ref={searchInputRef}
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape" && query.length > 0) {
                      event.preventDefault();
                      setQuery("");
                    }
                  }}
                  placeholder={t("Search commands or keys")}
                  aria-label={t("Search shortcuts")}
                  className="w-full [&_[data-slot=input]]:pl-8"
                  size="compact"
                />
              </div>
              <ToggleGroup
                aria-label={t("Show shortcuts")}
                variant="segmented"
                value={[visibleFilter]}
                onValueChange={(next) => {
                  const value = next[0];
                  if (isKeybindingFilter(value)) setFilter(value);
                }}
              >
                {(["all", "customized", "conflicts"] as const)
                  .filter((option) => option !== "conflicts" || summary.conflicts > 0)
                  .map((option) => {
                    const count =
                      option === "customized"
                        ? summary.customized
                        : option === "conflicts"
                          ? summary.conflicts
                          : null;
                    return (
                      <ToggleGroupItem key={option} value={option} className="gap-1.5 px-2.5">
                        {t(FILTER_LABELS[option])}
                        {count ? (
                          <span
                            className={cn(
                              "text-[11px] tabular-nums text-muted-foreground",
                              option === "conflicts" && "text-warning",
                            )}
                          >
                            {count}
                          </span>
                        ) : null}
                      </ToggleGroupItem>
                    );
                  })}
              </ToggleGroup>
            </div>

            {summary.conflicts > 0 && visibleFilter !== "conflicts" ? (
              <div
                role="status"
                className="flex items-center gap-2 rounded-lg border border-warning/25 bg-warning/5 px-3 py-2 text-[12px] leading-relaxed text-foreground"
              >
                <TriangleAlertIcon className="size-3.5 shrink-0 text-warning" />
                <p className="min-w-0 flex-1">
                  {plural(summary.conflicts, {
                    one: "{count} shortcut shares its keys with another command.",
                    other: "{count} shortcuts share their keys with another command.",
                  })}{" "}
                  <span className="text-muted-foreground">
                    {t("Only the one defined last will run.")}
                  </span>
                </p>
                <Button
                  type="button"
                  size="compact"
                  variant="ghost"
                  onClick={() => setFilter("conflicts")}
                >
                  {t("Review")}
                </Button>
              </div>
            ) : null}

            {!isElectron ? (
              <p className="flex items-start gap-2 px-1 text-[12px] leading-relaxed text-muted-foreground">
                <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
                {t(
                  "Your browser can claim some shortcuts before Akeru Bot sees them. The desktop app receives all of them.",
                )}
              </p>
            ) : null}
          </div>

          {isAddingBinding ? (
            <NewKeybindingCard
              commandOptions={commandOptions}
              allRows={allRows}
              variables={whenVariables}
              isSaving={savingCommand !== null}
              onSave={saveKeybinding}
              onCancel={() => setIsAddingBinding(false)}
            />
          ) : null}

          {groups.map((group) => (
            <div key={group.id} role="group" aria-label={group.title} className="space-y-2">
              <h3 className="px-3 text-[12px] font-medium text-muted-foreground sm:px-4">
                {group.title}
              </h3>
              <div className="divide-y divide-border/50 overflow-hidden rounded-xl border border-border/70 bg-settings-surface">
                {group.items.map((item) => {
                  if (item.type === "row") return renderRow(item.row);
                  const { series } = item;
                  const expanded = seriesExpansion[series.id] ?? seriesExpandedByDefault;
                  return (
                    <KeybindingSeriesItem
                      key={series.id}
                      series={series}
                      expanded={expanded}
                      onExpandedChange={(next) =>
                        setSeriesExpansion((current) => ({ ...current, [series.id]: next }))
                      }
                    >
                      {series.rows.map((row) => renderRow(row, true))}
                    </KeybindingSeriesItem>
                  );
                })}
              </div>
            </div>
          ))}

          {groups.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border/70 px-4 py-10 text-center text-sm text-muted-foreground">
              <p>{emptyStateMessage(visibleFilter, query, t)}</p>
              {query.length > 0 || visibleFilter !== "all" ? (
                <Button
                  type="button"
                  size="compact"
                  variant="outline"
                  onClick={() => {
                    setQuery("");
                    setFilter("all");
                  }}
                >
                  {t("Show all shortcuts")}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
