import {
  DURABLE_MEMORY_APPROVAL_LABELS,
  DURABLE_MEMORY_DELETION_LABELS,
  DURABLE_MEMORY_SCOPE_LABELS,
  type DurableImportReviewItem,
  type DurableMemoryExportScope,
  type DurableFactIntent,
  type DurableMemoryFact,
  IMPORT_CLASSIFICATION_LABELS,
  DURABLE_FACT_DELETE_CONFIRM,
  type DurableFactPolicy,
  canSaveDurableFactEdit,
  durableFactActions,
  durableFactBotsLabel,
  durableFactMoveScopes,
  durableFactSourceLabel,
  type ImportConflictDecision,
} from "@t3tools/client-runtime/durable-memory";
import type { MessageKey } from "@t3tools/client-runtime/i18n";
import type { AkeruMemoryImportClassification } from "@t3tools/contracts";

import { useI18n } from "../../i18n";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

const TIME_FORMAT: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" };

function formatTime(value: string, formatDate: ReturnType<typeof useI18n>["formatDate"]) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : formatDate(date, TIME_FORMAT);
}

/** Segmented scope choice. Each option is a pressed-state button so screen readers hear the pick. */
export function DurableScopePicker({
  label,
  options,
  value,
  disabled,
  onChange,
}: {
  readonly label: MessageKey;
  readonly options: ReadonlyArray<{
    readonly scope: DurableMemoryExportScope;
    readonly label: MessageKey;
  }>;
  readonly value: DurableMemoryExportScope;
  readonly disabled?: boolean;
  readonly onChange: (scope: DurableMemoryExportScope) => void;
}) {
  const { t } = useI18n();
  return (
    <div role="group" aria-label={t(label)} className="flex flex-wrap gap-1">
      {options.map((option) => (
        <Button
          key={option.scope}
          size="xs"
          variant={option.scope === value ? "secondary" : "ghost"}
          aria-pressed={option.scope === value}
          disabled={disabled}
          onClick={() => onChange(option.scope)}
        >
          {t(option.label)}
        </Button>
      ))}
    </div>
  );
}

export interface DurableFactEditing {
  readonly rootId: string;
  readonly draft: string;
}

const SIMPLE_ACTION_LABELS: Readonly<
  Record<"pin" | "unpin" | "approve" | "reject" | "forget", MessageKey>
> = {
  pin: "Pin",
  unpin: "Unpin",
  approve: "Approve",
  reject: "Reject",
  forget: "Forget",
};

/**
 * Durable fact cards with provenance, approval, the value each fact replaced, and the actions
 * the fact's state allows. This component holds no state: callers own editing, the delete
 * confirmation, and sending each intent.
 */
export function DurableFactList({
  facts,
  currentThreadId,
  currentBotId,
  threadTitles,
  botNames,
  policy,
  busyRootId,
  editing,
  confirmingDeleteRootId,
  onIntent,
  onStartEdit,
  onDraftChange,
  onCancelEdit,
  onRequestDelete,
  onCancelDelete,
}: {
  readonly facts: ReadonlyArray<DurableMemoryFact>;
  readonly currentThreadId: string;
  readonly currentBotId: string | null;
  /** Chat titles and bot names by id, so provenance never shows a raw id. */
  readonly threadTitles: ReadonlyMap<string, string>;
  readonly botNames: ReadonlyMap<string, string>;
  readonly policy: DurableFactPolicy;
  readonly busyRootId: string | null;
  readonly editing: DurableFactEditing | null;
  readonly confirmingDeleteRootId: string | null;
  readonly onIntent: (fact: DurableMemoryFact, intent: DurableFactIntent) => void;
  readonly onStartEdit: (fact: DurableMemoryFact) => void;
  readonly onDraftChange: (draft: string) => void;
  readonly onCancelEdit: () => void;
  readonly onRequestDelete: (fact: DurableMemoryFact) => void;
  readonly onCancelDelete: () => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  if (facts.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">{t("No durable facts in this scope yet.")}</p>
    );
  }
  return (
    <ul className="space-y-2" data-testid="durable-facts">
      {facts.map((fact) => {
        const busy = busyRootId !== null;
        const actions = durableFactActions(fact, policy);
        // An open draft or confirmation closes if the policy stops allowing its action.
        const isEditing = editing?.rootId === fact.rootId && actions.includes("edit");
        const confirmingDelete =
          confirmingDeleteRootId === fact.rootId && actions.includes("delete");
        const sourceLabel = durableFactSourceLabel(fact, { currentThreadId, threadTitles }, i18n);
        return (
          <li
            key={fact.rootId}
            className="space-y-1.5 rounded-md bg-muted/40 p-2.5 text-sm"
            aria-busy={busyRootId === fact.rootId}
          >
            {isEditing ? (
              <div className="space-y-1.5">
                <Textarea
                  aria-label={t("Edit fact")}
                  size="sm"
                  value={editing.draft}
                  disabled={busy}
                  onChange={(event) => onDraftChange(event.currentTarget.value)}
                />
                <div className="flex gap-1">
                  <Button
                    size="xs"
                    disabled={busy || !canSaveDurableFactEdit(fact, editing.draft)}
                    onClick={() => onIntent(fact, { action: "edit", fact: editing.draft })}
                  >
                    {t("Save")}
                  </Button>
                  <Button size="xs" variant="ghost" disabled={busy} onClick={onCancelEdit}>
                    {t("Cancel")}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-2">
                <p
                  className={
                    fact.deletionState === "active"
                      ? "min-w-0 flex-1 whitespace-pre-wrap"
                      : "min-w-0 flex-1 whitespace-pre-wrap text-muted-foreground"
                  }
                >
                  {fact.fact}
                </p>
                {fact.pinned ? (
                  <Badge size="sm" variant="secondary">
                    {t("Pinned")}
                  </Badge>
                ) : null}
                {fact.approvalState === "approved" ? null : (
                  <Badge size="sm" variant={fact.approvalState === "pending" ? "warning" : "error"}>
                    {t(DURABLE_MEMORY_APPROVAL_LABELS[fact.approvalState])}
                  </Badge>
                )}
                {fact.deletionState === "active" ? null : (
                  <Badge size="sm" variant="outline">
                    {t(DURABLE_MEMORY_DELETION_LABELS[fact.deletionState])}
                  </Badge>
                )}
              </div>
            )}
            {fact.supersededFact ? (
              <p className="text-xs text-muted-foreground">
                {t("Replaced:")} <span className="line-through">{fact.supersededFact}</span>
              </p>
            ) : null}
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              <dt>{t("Scope")}</dt>
              <dd>{t(DURABLE_MEMORY_SCOPE_LABELS[fact.scope])}</dd>
              <dt>{t("Status")}</dt>
              <dd>{factStatus(fact, t)}</dd>
              {sourceLabel === null ? null : (
                <>
                  <dt>{t("Source chat")}</dt>
                  <dd className="first-letter:uppercase">{sourceLabel}</dd>
                </>
              )}
              <dt>{t("Bots")}</dt>
              <dd className="first-letter:uppercase">
                {durableFactBotsLabel(fact, { currentBotId, botNames }, i18n) ?? t("None")}
              </dd>
              <dt>{t("Created")}</dt>
              <dd>{formatTime(fact.createdAt, i18n.formatDate)}</dd>
              <dt>{t("Updated")}</dt>
              <dd>{formatTime(fact.updatedAt, i18n.formatDate)}</dd>
            </dl>
            {busyRootId === fact.rootId ? (
              <p className="text-xs text-muted-foreground">{t("Saving…")}</p>
            ) : null}
            {confirmingDelete ? (
              <div role="alertdialog" aria-label={t("Delete fact")} className="space-y-1.5">
                <p className="text-xs">
                  {t(DURABLE_FACT_DELETE_CONFIRM.title)} {t(DURABLE_FACT_DELETE_CONFIRM.message)}
                </p>
                <div className="flex gap-1">
                  <Button
                    size="xs"
                    variant="destructive"
                    disabled={busy}
                    onClick={() => onIntent(fact, { action: "delete" })}
                  >
                    {t(DURABLE_FACT_DELETE_CONFIRM.confirm)}
                  </Button>
                  <Button size="xs" variant="ghost" disabled={busy} onClick={onCancelDelete}>
                    {t(DURABLE_FACT_DELETE_CONFIRM.cancel)}
                  </Button>
                </div>
              </div>
            ) : !isEditing && actions.length > 0 ? (
              <div role="group" aria-label={t("Fact actions")} className="flex flex-wrap gap-1">
                {actions.flatMap((action) => {
                  switch (action) {
                    case "edit":
                      return [
                        <Button
                          key="edit"
                          size="xs"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => onStartEdit(fact)}
                        >
                          {t("Edit")}
                        </Button>,
                      ];
                    case "move":
                      return durableFactMoveScopes(fact, policy).map((option) => (
                        <Button
                          key={`move:${option.scope}`}
                          size="xs"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => onIntent(fact, { action: "move", scope: option.scope })}
                        >
                          {t(option.label)}
                        </Button>
                      ));
                    case "delete":
                      return [
                        <Button
                          key="delete"
                          size="xs"
                          variant="ghost"
                          className="text-destructive"
                          disabled={busy}
                          onClick={() => onRequestDelete(fact)}
                        >
                          {t("Delete")}
                        </Button>,
                      ];
                    default:
                      return [
                        <Button
                          key={action}
                          size="xs"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => onIntent(fact, { action })}
                        >
                          {t(SIMPLE_ACTION_LABELS[action])}
                        </Button>,
                      ];
                  }
                })}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Approval, deletion, and pin state as one list, in the client's language. */
function factStatus(fact: DurableMemoryFact, t: (message: MessageKey) => string) {
  return [
    t(DURABLE_MEMORY_APPROVAL_LABELS[fact.approvalState]),
    fact.deletionState === "active" ? null : t(DURABLE_MEMORY_DELETION_LABELS[fact.deletionState]),
    fact.pinned ? t("Pinned") : null,
  ]
    .filter((part) => part !== null)
    .join(t(", "));
}

const CONFLICT_CHOICES: ReadonlyArray<{
  readonly decision: ImportConflictDecision;
  readonly label: MessageKey;
}> = [
  { decision: "keep-local", label: "Keep mine" },
  { decision: "use-archive", label: "Use archive" },
];

/**
 * Import review for a durable archive. Every conflict carries its own choice, and Apply stays
 * disabled until each one is made. This component holds no state so its callers own the choices.
 */
export function DurableImportReview({
  groups,
  choices,
  unresolvedCount,
  busy,
  onChoose,
  onApply,
  onCancel,
}: {
  readonly groups: ReadonlyArray<{
    readonly classification: AkeruMemoryImportClassification;
    readonly items: ReadonlyArray<DurableImportReviewItem>;
  }>;
  readonly choices: Readonly<Record<string, ImportConflictDecision | undefined>>;
  readonly unresolvedCount: number;
  readonly busy: boolean;
  readonly onChoose: (rootId: string, decision: ImportConflictDecision) => void;
  readonly onApply: () => void;
  readonly onCancel: () => void;
}) {
  const { t, plural } = useI18n();
  return (
    <div className="space-y-3 text-sm" data-testid="durable-import-review">
      {groups.length === 0 ? (
        <p className="text-muted-foreground">{t("This archive has no durable facts to import.")}</p>
      ) : null}
      {groups.map((group) => (
        <div key={group.classification} className="space-y-1.5">
          <h4 className="text-xs font-medium text-muted-foreground">
            {t("{label} ({count})", {
              label: t(IMPORT_CLASSIFICATION_LABELS[group.classification]),
              count: group.items.length,
            })}
          </h4>
          <ul className="space-y-1.5">
            {group.items.map((item) => (
              <li key={item.rootId} className="space-y-1 rounded-md bg-muted/40 p-2.5">
                {group.classification === "conflicting" ? (
                  <>
                    <p className="text-xs text-muted-foreground">
                      {t("Yours:")} {item.localFact ?? t("Not loaded")}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t("Archive:")} {item.archiveFact ?? t("Unknown")}
                    </p>
                    <div
                      role="radiogroup"
                      aria-label={t("Resolve conflict {id}", { id: item.rootId })}
                      className="flex gap-1"
                    >
                      {CONFLICT_CHOICES.map((choice) => (
                        <Button
                          key={choice.decision}
                          size="xs"
                          role="radio"
                          aria-checked={choices[item.rootId] === choice.decision}
                          variant={choices[item.rootId] === choice.decision ? "secondary" : "ghost"}
                          disabled={busy}
                          onClick={() => onChoose(item.rootId, choice.decision)}
                        >
                          {t(choice.label)}
                        </Button>
                      ))}
                    </div>
                  </>
                ) : (
                  <p>{item.archiveFact ?? item.rootId}</p>
                )}
                <p className="text-xs text-muted-foreground">{item.reason}</p>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {unresolvedCount > 0 ? (
        <p className="text-xs text-muted-foreground">
          {plural(unresolvedCount, {
            one: "Choose a version for {count} conflict before applying. Nothing changes until you apply.",
            other:
              "Choose a version for {count} conflicts before applying. Nothing changes until you apply.",
          })}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          {t("Cancel import")}
        </Button>
        <Button size="sm" disabled={busy || unresolvedCount > 0} onClick={onApply}>
          {t("Apply import")}
        </Button>
      </div>
    </div>
  );
}
