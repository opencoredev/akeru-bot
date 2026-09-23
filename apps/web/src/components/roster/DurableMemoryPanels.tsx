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
import type { AkeruMemoryImportClassification } from "@t3tools/contracts";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** Segmented scope choice. Each option is a pressed-state button so screen readers hear the pick. */
export function DurableScopePicker({
  label,
  options,
  value,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly options: ReadonlyArray<{
    readonly scope: DurableMemoryExportScope;
    readonly label: string;
  }>;
  readonly value: DurableMemoryExportScope;
  readonly disabled?: boolean;
  readonly onChange: (scope: DurableMemoryExportScope) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1">
      {options.map((option) => (
        <Button
          key={option.scope}
          size="xs"
          variant={option.scope === value ? "secondary" : "ghost"}
          aria-pressed={option.scope === value}
          disabled={disabled}
          onClick={() => onChange(option.scope)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}

export interface DurableFactEditing {
  readonly rootId: string;
  readonly draft: string;
}

const SIMPLE_ACTION_LABELS = {
  pin: "Pin",
  unpin: "Unpin",
  approve: "Approve",
  reject: "Reject",
  forget: "Forget",
} as const;

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
  if (facts.length === 0) {
    return <p className="text-sm text-muted-foreground">No durable facts in this scope yet.</p>;
  }
  return (
    <ul className="space-y-2" data-testid="durable-facts">
      {facts.map((fact) => {
        const busy = busyRootId !== null;
        const isEditing = editing?.rootId === fact.rootId;
        const confirmingDelete = confirmingDeleteRootId === fact.rootId;
        const actions = durableFactActions(fact, policy);
        return (
          <li
            key={fact.rootId}
            className="space-y-1.5 rounded-md bg-muted/40 p-2.5 text-sm"
            aria-busy={busyRootId === fact.rootId}
          >
            {isEditing ? (
              <div className="space-y-1.5">
                <Textarea
                  aria-label="Edit fact"
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
                    Save
                  </Button>
                  <Button size="xs" variant="ghost" disabled={busy} onClick={onCancelEdit}>
                    Cancel
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
                    Pinned
                  </Badge>
                ) : null}
                {fact.approvalState === "approved" ? null : (
                  <Badge size="sm" variant={fact.approvalState === "pending" ? "warning" : "error"}>
                    {DURABLE_MEMORY_APPROVAL_LABELS[fact.approvalState]}
                  </Badge>
                )}
                {fact.deletionState === "active" ? null : (
                  <Badge size="sm" variant="outline">
                    {DURABLE_MEMORY_DELETION_LABELS[fact.deletionState]}
                  </Badge>
                )}
              </div>
            )}
            {fact.supersededFact ? (
              <p className="text-xs text-muted-foreground">
                Replaced: <span className="line-through">{fact.supersededFact}</span>
              </p>
            ) : null}
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              <dt>Scope</dt>
              <dd>{DURABLE_MEMORY_SCOPE_LABELS[fact.scope]}</dd>
              <dt>Status</dt>
              <dd>
                {DURABLE_MEMORY_APPROVAL_LABELS[fact.approvalState]}
                {fact.deletionState === "active"
                  ? ""
                  : `, ${DURABLE_MEMORY_DELETION_LABELS[fact.deletionState]}`}
                {fact.pinned ? ", Pinned" : ""}
              </dd>
              <dt>Source chat</dt>
              <dd className="first-letter:uppercase">
                {durableFactSourceLabel(fact, { currentThreadId, threadTitles })}
              </dd>
              <dt>Bots</dt>
              <dd className="first-letter:uppercase">
                {durableFactBotsLabel(fact, { currentBotId, botNames }) ?? "None"}
              </dd>
              <dt>Created</dt>
              <dd>{formatTime(fact.createdAt)}</dd>
              <dt>Updated</dt>
              <dd>{formatTime(fact.updatedAt)}</dd>
            </dl>
            {busyRootId === fact.rootId ? (
              <p className="text-xs text-muted-foreground">Saving…</p>
            ) : null}
            {confirmingDelete ? (
              <div role="alertdialog" aria-label="Delete fact" className="space-y-1.5">
                <p className="text-xs">
                  {DURABLE_FACT_DELETE_CONFIRM.title} {DURABLE_FACT_DELETE_CONFIRM.message}
                </p>
                <div className="flex gap-1">
                  <Button
                    size="xs"
                    variant="destructive"
                    disabled={busy}
                    onClick={() => onIntent(fact, { action: "delete" })}
                  >
                    {DURABLE_FACT_DELETE_CONFIRM.confirm}
                  </Button>
                  <Button size="xs" variant="ghost" disabled={busy} onClick={onCancelDelete}>
                    {DURABLE_FACT_DELETE_CONFIRM.cancel}
                  </Button>
                </div>
              </div>
            ) : !isEditing && actions.length > 0 ? (
              <div role="group" aria-label="Fact actions" className="flex flex-wrap gap-1">
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
                          Edit
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
                          {option.label}
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
                          Delete
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
                          {SIMPLE_ACTION_LABELS[action]}
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

const CONFLICT_CHOICES: ReadonlyArray<{
  readonly decision: ImportConflictDecision;
  readonly label: string;
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
  return (
    <div className="space-y-3 text-sm" data-testid="durable-import-review">
      {groups.length === 0 ? (
        <p className="text-muted-foreground">This archive has no durable facts to import.</p>
      ) : null}
      {groups.map((group) => (
        <div key={group.classification} className="space-y-1.5">
          <h4 className="text-xs font-medium text-muted-foreground">
            {IMPORT_CLASSIFICATION_LABELS[group.classification]} ({group.items.length})
          </h4>
          <ul className="space-y-1.5">
            {group.items.map((item) => (
              <li key={item.rootId} className="space-y-1 rounded-md bg-muted/40 p-2.5">
                {group.classification === "conflicting" ? (
                  <>
                    <p className="text-xs text-muted-foreground">
                      Yours: {item.localFact ?? "Not loaded"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Archive: {item.archiveFact ?? "Unknown"}
                    </p>
                    <div
                      role="radiogroup"
                      aria-label={`Resolve conflict ${item.rootId}`}
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
                          {choice.label}
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
          Choose a version for {unresolvedCount} {unresolvedCount === 1 ? "conflict" : "conflicts"}{" "}
          before applying. Nothing changes until you apply.
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel import
        </Button>
        <Button size="sm" disabled={busy || unresolvedCount > 0} onClick={onApply}>
          Apply import
        </Button>
      </div>
    </div>
  );
}
