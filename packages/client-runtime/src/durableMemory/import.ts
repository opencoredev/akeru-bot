import * as Predicate from "effect/Predicate";
import {
  type AkeruMemoryArchiveV2,
  type AkeruMemoryImportClassification,
  type AkeruMemoryImportPreview,
  type AkeruMemoryImportPreviewItem,
  type AkeruMemoryRootId,
} from "@akeru/contracts";
import { type MessageKey } from "../i18n/index.ts";
import { type DurableMemoryExportScope } from "./types.ts";
import { type DurableMemoryFact, durableFactsFromArchive } from "./facts.ts";

export const IMPORT_CLASSIFICATION_ORDER: ReadonlyArray<AkeruMemoryImportClassification> = [
  "conflicting",
  "new",
  "changed",
  "skipped",
];

export const IMPORT_CLASSIFICATION_LABELS: Readonly<
  Record<AkeruMemoryImportClassification, MessageKey>
> = {
  conflicting: "Conflicts",
  new: "New",
  changed: "Changed",
  skipped: "Skipped",
};

export type ImportConflictDecision = "keep-local" | "use-archive";

export interface DurableImportReviewItem extends AkeruMemoryImportPreviewItem {
  /** Current text of the archive chain for this root. */
  readonly archiveFact: string | null;
  /** Current local text, when the caller has loaded local facts for the same scope. */
  readonly localFact: string | null;
}

export function groupImportPreview(input: {
  readonly preview: AkeruMemoryImportPreview;
  readonly archive: AkeruMemoryArchiveV2;
  readonly localFacts?: ReadonlyArray<DurableMemoryFact>;
}): ReadonlyArray<{
  readonly classification: AkeruMemoryImportClassification;
  readonly items: ReadonlyArray<DurableImportReviewItem>;
}> {
  const archiveFacts = new Map(
    durableFactsFromArchive(input.archive).map((fact) => [fact.rootId, fact.fact]),
  );

  const localFacts = new Map((input.localFacts ?? []).map((fact) => [fact.rootId, fact.fact]));

  return IMPORT_CLASSIFICATION_ORDER.flatMap((classification) => {
    const items = input.preview.items.flatMap((item) =>
      item.classification === classification
        ? [
            {
              ...item,
              archiveFact: archiveFacts.get(item.rootId) ?? null,
              localFact: localFacts.get(item.rootId) ?? null,
            },
          ]
        : [],
    );

    return items.length > 0 ? [{ classification, items }] : [];
  });
}

/**
 * Resolutions for an import apply request, or the conflicts still waiting for a choice.
 * There is no default decision: every conflict must be chosen before anything applies.
 */
export function resolveImportConflicts(
  preview: AkeruMemoryImportPreview,
  choices: Readonly<Record<string, ImportConflictDecision | undefined>>,
):
  | {
      readonly ready: true;
      readonly resolutions: ReadonlyArray<{
        readonly rootId: AkeruMemoryRootId;
        readonly decision: ImportConflictDecision;
      }>;
    }
  | { readonly ready: false; readonly unresolved: ReadonlyArray<AkeruMemoryRootId> } {
  const conflicts = preview.items.filter((item) => item.classification === "conflicting");
  const unresolved = conflicts.filter((item) => choices[item.rootId] === undefined);

  if (unresolved.length > 0) {
    return { ready: false, unresolved: unresolved.map((item) => item.rootId) };
  }

  return {
    ready: true,
    resolutions: conflicts.map((item) => ({
      rootId: item.rootId,
      decision: choices[item.rootId]!,
    })),
  };
}

/** Durable archives are schema version 2; bot-note archives are version 3. */
export function memoryArchiveSchemaVersion(value: unknown): number | null {
  if (typeof value !== "object" || value === null || !("schemaVersion" in value)) return null;

  return Predicate.isNumber(value.schemaVersion) ? value.schemaVersion : null;
}

export function durableMemoryExportFileName(scope: DurableMemoryExportScope, threadId: string) {
  return `akeru-durable-memory-${scope}-${threadId}.json`;
}
