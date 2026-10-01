import {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@akeru/contracts";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { storedField } from "../lib/persistedSchema";
import { PersistedComposerImageAttachment } from "./draftPersistenceSchemas";

const optionalJson = storedField(Schema.Union([Schema.Json, Schema.Undefined]), undefined);

const optionalString = storedField(Schema.NullOr(Schema.String), null);

const optionalNumber = storedField(Schema.NullOr(Schema.Number.check(Schema.isFinite())), null);

const StoredElementSource = Schema.Struct({
  functionName: optionalString,
  fileName: optionalString,
  lineNumber: optionalNumber,
  columnNumber: optionalNumber,
});

const StoredElementContext = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  pickedAt: Schema.String,
  pageUrl: Schema.String,
  tagName: Schema.String,
  pageTitle: optionalString,
  selector: optionalString,
  htmlPreview: storedField(Schema.String, ""),
  componentName: optionalString,
  source: storedField(Schema.NullOr(StoredElementSource), null),
  styles: storedField(Schema.String, ""),
});

const StoredTerminalContext = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  createdAt: Schema.String,
  terminalId: Schema.String,
  terminalLabel: Schema.String,
  lineStart: Schema.Number.check(Schema.isFinite()),
  lineEnd: Schema.Number.check(Schema.isFinite()),
});

const isProviderInstanceId = Schema.is(ProviderInstanceId);

const recoveredModelSelections = Schema.Record(
  Schema.String,
  storedField(Schema.NullOr(ModelSelection), null),
).pipe(
  Schema.decodeTo(
    Schema.toType(Schema.Record(ProviderInstanceId, ModelSelection)),
    SchemaTransformation.transform({
      decode: (selections) =>
        Object.fromEntries(
          Object.entries(selections).flatMap(([key, selection]) =>
            isProviderInstanceId(key) && selection !== null ? [[key, selection] as const] : [],
          ),
        ),
      encode: (selections) => selections,
    }),
  ),
);

const storedModelSelections = storedField(Schema.NullOr(recoveredModelSelections), null);

export const StoredDraftThread = Schema.Struct({
  threadId: storedField(Schema.NullOr(ThreadId), null),
  environmentId: storedField(Schema.NullOr(EnvironmentId), null),
  projectId: storedField(Schema.NullOr(ProjectId), null),
  logicalProjectKey: optionalString,
  createdAt: optionalString,
  branch: optionalString,
  worktreePath: optionalString,
  startFromOrigin: storedField(Schema.Boolean, false),
  envMode: optionalJson,
  runtimeMode: optionalJson,
  interactionMode: optionalJson,
  promotedTo: storedField(
    Schema.NullOr(
      Schema.Struct({
        environmentId: EnvironmentId,
        threadId: ThreadId,
      }),
    ),
    null,
  ),
});

export const StoredComposerDraft = Schema.Struct({
  prompt: storedField(Schema.String, ""),
  attachments: storedField(
    Schema.Array(storedField(Schema.NullOr(PersistedComposerImageAttachment), null)),
    [],
  ),
  terminalContexts: storedField(
    Schema.Array(storedField(Schema.NullOr(StoredTerminalContext), null)),
    [],
  ),
  elementContexts: storedField(
    Schema.Array(storedField(Schema.NullOr(StoredElementContext), null)),
    [],
  ),
  modelSelectionByProvider: storedModelSelections,
  activeProvider: optionalJson,
  runtimeMode: optionalJson,
  interactionMode: optionalJson,
  modelOptions: optionalJson,
  modelSelection: optionalJson,
  provider: optionalJson,
  model: optionalJson,
  effort: optionalJson,
  codexFastMode: optionalJson,
  serviceTier: optionalJson,
});

const draftThreads = storedField(
  Schema.NullOr(Schema.Record(Schema.String, storedField(Schema.NullOr(StoredDraftThread), null))),
  null,
);

const drafts = storedField(
  Schema.NullOr(
    Schema.Record(Schema.String, storedField(Schema.NullOr(StoredComposerDraft), null)),
  ),
  null,
);

const projectDraftKeys = storedField(
  Schema.NullOr(Schema.Record(Schema.String, storedField(Schema.NullOr(Schema.String), null))),
  null,
);

export const StoredComposerMigration = Schema.Struct({
  draftsByThreadKey: drafts,
  draftsByThreadId: drafts,
  draftThreadsByThreadKey: draftThreads,
  draftThreadsByThreadId: draftThreads,
  logicalProjectDraftThreadKeyByLogicalProjectKey: projectDraftKeys,
  projectDraftThreadKeyByProjectKey: projectDraftKeys,
  projectDraftThreadIdByProjectKey: projectDraftKeys,
  projectDraftThreadIdByProjectId: projectDraftKeys,
  stickyModelSelectionByProvider: storedModelSelections,
  stickyActiveProvider: optionalJson,
  stickyProvider: optionalJson,
  stickyModel: optionalJson,
  stickyModelOptions: optionalJson,
  stickyModelSelection: optionalJson,
});

export type StoredComposerMigration = typeof StoredComposerMigration.Type;

export type StoredComposerDraft = typeof StoredComposerDraft.Type;

export type StoredElementContext = typeof StoredElementContext.Type;

export type StoredTerminalContext = typeof StoredTerminalContext.Type;
