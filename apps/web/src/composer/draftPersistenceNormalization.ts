import {
  type StoredComposerMigration,
  type StoredElementContext,
  type StoredTerminalContext,
} from "./draftMigrationSchemas";
import * as Predicate from "effect/Predicate";
import {
  DEFAULT_LOCAL_EXECUTION_MODE,
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@akeru/contracts";
import {
  parseScopedProjectKey,
  parseScopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@akeru/client-runtime/environment";
import { DeepMutable } from "effect/Types";
import { DEFAULT_INTERACTION_MODE } from "../types";
import { ensureInlineTerminalContextPlaceholders } from "../lib/terminalContext";
import {
  type PersistedComposerImageAttachment,
  type PersistedElementContextDraft,
  type PersistedTerminalContextDraft,
  type PersistedComposerDraftStoreState,
  type PersistedDraftThreadState,
} from "./draftPersistenceSchemas";
import {
  normalizeLegacyComposerStorageKey,
  projectDraftKey,
  normalizeDraftThreadEnvMode,
  composerThreadRefFromKey,
} from "./draftIdentity";
import { isRuntimeMode } from "./draftTypes";
import {
  normalizeProviderInstanceId,
  normalizeProviderModelOptions,
  normalizeModelSelection,
  legacyMergeModelSelectionIntoProviderModelOptions,
  legacySyncModelSelectionOptions,
  legacyToModelSelectionByProvider,
  compactModelSelectionByProvider,
} from "./draftModelSelection";

function normalizePersistedAttachment(
  value: PersistedComposerImageAttachment | null,
): PersistedComposerImageAttachment | null {
  if (!Predicate.isObjectOrArray(value)) {
    return null;
  }

  const candidate = value;
  const id = candidate.id;
  const name = candidate.name;
  const mimeType = candidate.mimeType;
  const sizeBytes = candidate.sizeBytes;
  const dataUrl = candidate.dataUrl;

  if (
    !Predicate.isString(id) ||
    !Predicate.isString(name) ||
    !Predicate.isString(mimeType) ||
    !Predicate.isNumber(sizeBytes) ||
    !Number.isFinite(sizeBytes) ||
    !Predicate.isString(dataUrl) ||
    id.length === 0 ||
    dataUrl.length === 0
  ) {
    return null;
  }

  return {
    id,
    name,
    mimeType,
    sizeBytes,
    dataUrl,
  };
}

function normalizePersistedElementContextDraft(
  value: StoredElementContext | null,
): PersistedElementContextDraft | null {
  if (!Predicate.isObjectOrArray(value)) return null;
  const candidate = value;
  const id = candidate.id;
  const threadId = candidate.threadId;
  const pickedAt = candidate.pickedAt;
  const pageUrl = candidate.pageUrl;
  const tagName = candidate.tagName;

  if (
    !Predicate.isString(id) ||
    id.length === 0 ||
    !Predicate.isString(threadId) ||
    threadId.length === 0 ||
    !Predicate.isString(pickedAt) ||
    pickedAt.length === 0 ||
    !Predicate.isString(pageUrl) ||
    pageUrl.length === 0 ||
    !Predicate.isString(tagName) ||
    tagName.length === 0
  ) {
    return null;
  }

  const sourceCandidate = candidate.source;
  let source: PersistedElementContextDraft["source"] = null;

  if (Predicate.isObjectOrArray(sourceCandidate)) {
    const sourceRecord = sourceCandidate;
    source = {
      functionName: Predicate.isString(sourceRecord.functionName)
        ? sourceRecord.functionName
        : null,
      fileName: Predicate.isString(sourceRecord.fileName) ? sourceRecord.fileName : null,
      lineNumber:
        Predicate.isNumber(sourceRecord.lineNumber) && Number.isFinite(sourceRecord.lineNumber)
          ? sourceRecord.lineNumber
          : null,
      columnNumber:
        Predicate.isNumber(sourceRecord.columnNumber) && Number.isFinite(sourceRecord.columnNumber)
          ? sourceRecord.columnNumber
          : null,
    };
  }

  return {
    id,
    threadId: ThreadId.make(threadId),
    pickedAt,
    pageUrl,
    pageTitle: Predicate.isString(candidate.pageTitle) ? candidate.pageTitle : null,
    tagName,
    selector: Predicate.isString(candidate.selector) ? candidate.selector : null,
    htmlPreview: Predicate.isString(candidate.htmlPreview) ? candidate.htmlPreview : "",
    componentName: Predicate.isString(candidate.componentName) ? candidate.componentName : null,
    source,
    styles: Predicate.isString(candidate.styles) ? candidate.styles : "",
  };
}

function normalizePersistedTerminalContextDraft(
  value: StoredTerminalContext | null,
): PersistedTerminalContextDraft | null {
  if (!Predicate.isObjectOrArray(value)) {
    return null;
  }

  const candidate = value;
  const id = candidate.id;
  const threadId = candidate.threadId;
  const createdAt = candidate.createdAt;
  const lineStart = candidate.lineStart;
  const lineEnd = candidate.lineEnd;

  if (
    !Predicate.isString(id) ||
    id.length === 0 ||
    !Predicate.isString(threadId) ||
    threadId.length === 0 ||
    !Predicate.isString(createdAt) ||
    createdAt.length === 0 ||
    !Predicate.isNumber(lineStart) ||
    !Number.isFinite(lineStart) ||
    !Predicate.isNumber(lineEnd) ||
    !Number.isFinite(lineEnd)
  ) {
    return null;
  }

  const terminalId = Predicate.isString(candidate.terminalId) ? candidate.terminalId.trim() : "";

  const terminalLabel = Predicate.isString(candidate.terminalLabel)
    ? candidate.terminalLabel.trim()
    : "";

  if (terminalId.length === 0 || terminalLabel.length === 0) {
    return null;
  }

  const normalizedLineStart = Math.max(1, Math.floor(lineStart));
  const normalizedLineEnd = Math.max(normalizedLineStart, Math.floor(lineEnd));

  return {
    id,
    threadId: ThreadId.make(threadId),
    createdAt,
    terminalId,
    terminalLabel,
    lineStart: normalizedLineStart,
    lineEnd: normalizedLineEnd,
  };
}

export function normalizePersistedDraftThreads(
  rawDraftThreadsByThreadId: StoredComposerMigration["draftThreadsByThreadKey"],
  rawProjectDraftThreadIdByProjectKey: StoredComposerMigration["logicalProjectDraftThreadKeyByLogicalProjectKey"],
): Pick<
  PersistedComposerDraftStoreState,
  "draftThreadsByThreadKey" | "logicalProjectDraftThreadKeyByLogicalProjectKey"
> {
  const draftThreadsByThreadKey: Record<string, PersistedDraftThreadState> = {};
  const environmentIdByThreadId = new Map<ThreadId, EnvironmentId>();

  if (
    rawProjectDraftThreadIdByProjectKey &&
    (rawProjectDraftThreadIdByProjectKey === null ||
      Predicate.isObjectOrArray(rawProjectDraftThreadIdByProjectKey))
  ) {
    for (const [projectKey, threadId] of Object.entries(rawProjectDraftThreadIdByProjectKey)) {
      if (!Predicate.isString(threadId) || threadId.length === 0) {
        continue;
      }

      const projectRef = parseScopedProjectKey(projectKey);

      if (!projectRef) {
        continue;
      }

      const parsedThreadRef = parseScopedThreadKey(threadId);

      if (parsedThreadRef) {
        environmentIdByThreadId.set(parsedThreadRef.threadId, parsedThreadRef.environmentId);
        continue;
      }

      environmentIdByThreadId.set(ThreadId.make(threadId), projectRef.environmentId);
    }
  }

  if (Predicate.isObjectOrArray(rawDraftThreadsByThreadId)) {
    for (const [threadKeyOrId, rawDraftThread] of Object.entries(rawDraftThreadsByThreadId)) {
      if (!Predicate.isString(threadKeyOrId) || threadKeyOrId.length === 0) {
        continue;
      }

      if (!Predicate.isObjectOrArray(rawDraftThread)) {
        continue;
      }

      const candidateDraftThread = rawDraftThread;
      const parsedThreadRef = parseScopedThreadKey(threadKeyOrId);
      const threadKey = normalizeLegacyComposerStorageKey(threadKeyOrId);

      const threadId =
        parsedThreadRef?.threadId ??
        (Predicate.isString(candidateDraftThread.threadId) &&
        candidateDraftThread.threadId.length > 0
          ? ThreadId.make(candidateDraftThread.threadId)
          : ThreadId.make(threadKeyOrId));

      const environmentId =
        parsedThreadRef?.environmentId ??
        (Predicate.isString(candidateDraftThread.environmentId) &&
        candidateDraftThread.environmentId.length > 0
          ? EnvironmentId.make(candidateDraftThread.environmentId)
          : environmentIdByThreadId.get(ThreadId.make(threadKeyOrId)));

      const projectId = candidateDraftThread.projectId;
      const createdAt = candidateDraftThread.createdAt;
      const branch = candidateDraftThread.branch;
      const worktreePath = candidateDraftThread.worktreePath;
      const startFromOrigin = candidateDraftThread.startFromOrigin === true;
      const normalizedWorktreePath = Predicate.isString(worktreePath) ? worktreePath : null;
      const promotedToCandidate = candidateDraftThread.promotedTo;

      const promotedToRecord = Predicate.isObjectOrArray(promotedToCandidate)
        ? promotedToCandidate
        : null;

      const promotedTo =
        promotedToRecord &&
        Predicate.isString(promotedToRecord.environmentId) &&
        promotedToRecord.environmentId.length > 0 &&
        Predicate.isString(promotedToRecord.threadId) &&
        promotedToRecord.threadId.length > 0
          ? scopeThreadRef(
              EnvironmentId.make(promotedToRecord.environmentId),
              ThreadId.make(promotedToRecord.threadId),
            )
          : null;

      if (!Predicate.isString(projectId) || projectId.length === 0 || environmentId === undefined) {
        continue;
      }

      const normalizedEnvironmentId = EnvironmentId.make(environmentId);
      draftThreadsByThreadKey[threadKey] = {
        threadId,
        environmentId: normalizedEnvironmentId,
        projectId: ProjectId.make(projectId),
        logicalProjectKey:
          Predicate.isString(candidateDraftThread.logicalProjectKey) &&
          candidateDraftThread.logicalProjectKey.length > 0
            ? candidateDraftThread.logicalProjectKey
            : parsedThreadRef
              ? projectDraftKey(scopeProjectRef(normalizedEnvironmentId, ProjectId.make(projectId)))
              : threadKeyOrId,
        createdAt:
          Predicate.isString(createdAt) && createdAt.length > 0
            ? createdAt
            : new Date().toISOString(),
        runtimeMode: isRuntimeMode(candidateDraftThread.runtimeMode)
          ? candidateDraftThread.runtimeMode
          : DEFAULT_LOCAL_EXECUTION_MODE,
        interactionMode:
          candidateDraftThread.interactionMode === "plan" ||
          candidateDraftThread.interactionMode === "default"
            ? candidateDraftThread.interactionMode
            : DEFAULT_INTERACTION_MODE,
        branch: Predicate.isString(branch) ? branch : null,
        worktreePath: normalizedWorktreePath,
        envMode: normalizeDraftThreadEnvMode(candidateDraftThread.envMode, normalizedWorktreePath),
        startFromOrigin,
        promotedTo,
      };
    }
  }

  const logicalProjectDraftThreadKeyByLogicalProjectKey: Record<string, string> = {};

  if (
    rawProjectDraftThreadIdByProjectKey &&
    (rawProjectDraftThreadIdByProjectKey === null ||
      Predicate.isObjectOrArray(rawProjectDraftThreadIdByProjectKey))
  ) {
    for (const [logicalProjectKey, threadKeyOrId] of Object.entries(
      rawProjectDraftThreadIdByProjectKey,
    )) {
      if (!Predicate.isString(threadKeyOrId) || threadKeyOrId.length === 0) {
        continue;
      }

      const projectRef = parseScopedProjectKey(logicalProjectKey);
      const parsedThreadRef = parseScopedThreadKey(threadKeyOrId);
      const threadKey = normalizeLegacyComposerStorageKey(threadKeyOrId);
      logicalProjectDraftThreadKeyByLogicalProjectKey[logicalProjectKey] = threadKey;

      if (parsedThreadRef) {
        environmentIdByThreadId.set(parsedThreadRef.threadId, parsedThreadRef.environmentId);
      }

      if (!projectRef) {
        const existingDraftThread = draftThreadsByThreadKey[threadKey];

        if (existingDraftThread && !existingDraftThread.logicalProjectKey) {
          draftThreadsByThreadKey[threadKey] = {
            ...existingDraftThread,
            logicalProjectKey,
          };
        }

        continue;
      }

      if (!draftThreadsByThreadKey[threadKey]) {
        draftThreadsByThreadKey[threadKey] = {
          threadId: parsedThreadRef?.threadId ?? ThreadId.make(threadKey),
          environmentId: projectRef.environmentId,
          projectId: projectRef.projectId,
          logicalProjectKey,
          createdAt: new Date().toISOString(),
          runtimeMode: DEFAULT_LOCAL_EXECUTION_MODE,
          interactionMode: DEFAULT_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          envMode: "local",
          startFromOrigin: false,
          promotedTo: null,
        };
      } else if (
        draftThreadsByThreadKey[threadKey]?.projectId !== projectRef.projectId ||
        draftThreadsByThreadKey[threadKey]?.environmentId !== projectRef.environmentId
      ) {
        draftThreadsByThreadKey[threadKey] = {
          ...draftThreadsByThreadKey[threadKey]!,
          threadId: draftThreadsByThreadKey[threadKey]!.threadId,
          environmentId: projectRef.environmentId,
          projectId: projectRef.projectId,
          logicalProjectKey,
        };
      }
    }
  }

  return { draftThreadsByThreadKey, logicalProjectDraftThreadKeyByLogicalProjectKey };
}

export function normalizePersistedDraftsByThreadId(
  rawDraftMap: StoredComposerMigration["draftsByThreadKey"],
  draftThreadsByThreadKey: PersistedComposerDraftStoreState["draftThreadsByThreadKey"],
): PersistedComposerDraftStoreState["draftsByThreadKey"] {
  if (!Predicate.isObjectOrArray(rawDraftMap)) {
    return {};
  }

  const environmentIdByThreadId = new Map<ThreadId, EnvironmentId>();

  for (const [threadKey, draftThread] of Object.entries(draftThreadsByThreadKey)) {
    const parsedThreadRef = composerThreadRefFromKey(threadKey);

    if (!parsedThreadRef) {
      continue;
    }

    environmentIdByThreadId.set(
      parsedThreadRef.threadId,
      EnvironmentId.make(draftThread.environmentId),
    );
  }

  const nextDraftsByThreadKey: DeepMutable<PersistedComposerDraftStoreState["draftsByThreadKey"]> =
    {};

  for (const [threadKeyOrId, draftValue] of Object.entries(rawDraftMap)) {
    if (!Predicate.isString(threadKeyOrId) || threadKeyOrId.length === 0) {
      continue;
    }

    if (!Predicate.isObjectOrArray(draftValue)) {
      continue;
    }

    const draftCandidate = draftValue;
    const promptCandidate = Predicate.isString(draftCandidate.prompt) ? draftCandidate.prompt : "";

    const attachments = Array.isArray(draftCandidate.attachments)
      ? draftCandidate.attachments.flatMap((entry) => {
          const normalized = normalizePersistedAttachment(entry);

          return normalized ? [normalized] : [];
        })
      : [];

    const terminalContexts = Array.isArray(draftCandidate.terminalContexts)
      ? draftCandidate.terminalContexts.flatMap((entry) => {
          const normalized = normalizePersistedTerminalContextDraft(entry);

          return normalized ? [normalized] : [];
        })
      : [];

    const elementContexts = Array.isArray(draftCandidate.elementContexts)
      ? draftCandidate.elementContexts.flatMap((entry) => {
          const normalized = normalizePersistedElementContextDraft(entry);

          return normalized ? [normalized] : [];
        })
      : [];

    const runtimeMode = isRuntimeMode(draftCandidate.runtimeMode)
      ? draftCandidate.runtimeMode
      : null;

    const interactionMode =
      draftCandidate.interactionMode === "plan" || draftCandidate.interactionMode === "default"
        ? draftCandidate.interactionMode
        : null;

    const prompt = ensureInlineTerminalContextPlaceholders(
      promptCandidate,
      terminalContexts.length,
    );

    // If the draft already has the v3 shape, use it directly
    const legacyDraftCandidate = draftValue;
    let modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>> = {};
    let activeProvider: ProviderInstanceId | null = null;

    if (
      draftCandidate.modelSelectionByProvider &&
      (draftCandidate.modelSelectionByProvider === null ||
        Predicate.isObjectOrArray(draftCandidate.modelSelectionByProvider))
    ) {
      // v3 format
      modelSelectionByProvider = draftCandidate.modelSelectionByProvider;
      activeProvider = normalizeProviderInstanceId(draftCandidate.activeProvider);
    } else {
      // v2 or legacy format: migrate
      const normalizedModelOptions =
        normalizeProviderModelOptions(
          legacyDraftCandidate.modelOptions,
          undefined,
          legacyDraftCandidate,
        ) ?? null;

      const normalizedModelSelection = normalizeModelSelection(
        legacyDraftCandidate.modelSelection,
        {
          provider: legacyDraftCandidate.provider,
          model: legacyDraftCandidate.model,
          modelOptions: normalizedModelOptions ?? legacyDraftCandidate.modelOptions,
          legacyCodex: legacyDraftCandidate,
        },
      );

      const mergedModelOptions = legacyMergeModelSelectionIntoProviderModelOptions(
        normalizedModelSelection,
        normalizedModelOptions,
      );

      const modelSelection = legacySyncModelSelectionOptions(
        normalizedModelSelection,
        mergedModelOptions,
      );

      modelSelectionByProvider = legacyToModelSelectionByProvider(
        modelSelection,
        mergedModelOptions,
      );
      activeProvider = modelSelection?.instanceId ?? null;
    }

    const hasModelData =
      Object.keys(modelSelectionByProvider).length > 0 || activeProvider !== null;

    if (
      promptCandidate.length === 0 &&
      attachments.length === 0 &&
      terminalContexts.length === 0 &&
      elementContexts.length === 0 &&
      !hasModelData &&
      !runtimeMode &&
      !interactionMode
    ) {
      continue;
    }

    const parsedThreadRef = parseScopedThreadKey(threadKeyOrId);

    const normalizedThreadKey =
      parsedThreadRef !== null
        ? normalizeLegacyComposerStorageKey(threadKeyOrId)
        : draftThreadsByThreadKey[threadKeyOrId] !== undefined
          ? threadKeyOrId
          : (() => {
              const environmentId = environmentIdByThreadId.get(ThreadId.make(threadKeyOrId));

              return environmentId
                ? normalizeLegacyComposerStorageKey(threadKeyOrId, { environmentId })
                : threadKeyOrId;
            })();

    nextDraftsByThreadKey[normalizedThreadKey] = {
      prompt,
      attachments,
      ...(terminalContexts.length > 0 ? { terminalContexts } : {}),
      ...(elementContexts.length > 0 ? { elementContexts } : {}),
      ...(hasModelData
        ? {
            modelSelectionByProvider: compactModelSelectionByProvider(modelSelectionByProvider),
            activeProvider,
          }
        : {}),
      ...(runtimeMode ? { runtimeMode } : {}),
      ...(interactionMode ? { interactionMode } : {}),
    };
  }

  return nextDraftsByThreadKey;
}
