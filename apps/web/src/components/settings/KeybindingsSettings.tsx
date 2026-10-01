import type { MessageKey } from "@akeru/client-runtime/i18n";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@akeru/client-runtime/state/runtime";
import { type KeybindingCommand, type ServerUpsertKeybindingInput } from "@akeru/contracts";
import { useAtomValue } from "@effect/atom-react";
import { FileJsonIcon, InfoIcon, PlusIcon, SearchIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOpenInPreferredEditor } from "../../editorPreferences";
import { isElectron } from "../../env";
import { useI18n } from "../../i18n";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironment } from "../../state/environments";
import {
  primaryServerAvailableEditorsAtom,
  primaryServerKeybindingsAtom,
  primaryServerKeybindingsConfigPathAtom,
  serverEnvironment,
} from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { ToggleGroup, Toggle as ToggleGroupItem } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { NewKeybindingCard, rowKeybindingTarget } from "./KeybindingEditors";
import { Translate } from "./KeybindingPresentation";
import { KeybindingListRow, KeybindingSeriesItem } from "./KeybindingRows";
import {
  type KeybindingFilter,
  type KeybindingRow,
  buildKeybindingCommandOptions,
  buildKeybindingGroups,
  buildKeybindingRows,
  buildWhenVariableOptions,
  summarizeKeybindings,
} from "./KeybindingsSettings.logic";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

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
                  variant="keybinding-search"
                  className="w-full"
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
                {(["all", "customized", "conflicts"] as const).flatMap((option) => {
                  if (option === "conflicts" && summary.conflicts === 0) return [];
                  const count =
                    option === "customized"
                      ? summary.customized
                      : option === "conflicts"
                        ? summary.conflicts
                        : null;
                  return (
                    <ToggleGroupItem key={option} value={option} size="keybinding-filter">
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
                className="flex items-center gap-2 rounded-lg border border-warning/25 bg-warning/5 px-3 py-2 text-xs leading-relaxed text-foreground"
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
              <p className="flex items-start gap-2 px-1 text-xs leading-relaxed text-muted-foreground">
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
