import {
  DEFAULT_LOCAL_EXECUTION_MODE,
  type EnvironmentId,
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
  type PersistedComposerThreadDraftState,
  type LegacyPersistedComposerThreadDraftState,
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

function normalizePersistedAttachment(value: unknown): PersistedComposerImageAttachment | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const id = candidate.id;
  const name = candidate.name;
  const mimeType = candidate.mimeType;
  const sizeBytes = candidate.sizeBytes;
  const dataUrl = candidate.dataUrl;

  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    typeof mimeType !== "string" ||
    typeof sizeBytes !== "number" ||
    !Number.isFinite(sizeBytes) ||
    typeof dataUrl !== "string" ||
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
  value: unknown,
): PersistedElementContextDraft | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const id = candidate.id;
  const threadId = candidate.threadId;
  const pickedAt = candidate.pickedAt;
  const pageUrl = candidate.pageUrl;
  const tagName = candidate.tagName;

  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof threadId !== "string" ||
    threadId.length === 0 ||
    typeof pickedAt !== "string" ||
    pickedAt.length === 0 ||
    typeof pageUrl !== "string" ||
    pageUrl.length === 0 ||
    typeof tagName !== "string" ||
    tagName.length === 0
  ) {
    return null;
  }

  const sourceCandidate = candidate.source;
  let source: PersistedElementContextDraft["source"] = null;

  if (sourceCandidate && typeof sourceCandidate === "object") {
    const sourceRecord = sourceCandidate as Record<string, unknown>;
    source = {
      functionName:
        typeof sourceRecord.functionName === "string" ? sourceRecord.functionName : null,
      fileName: typeof sourceRecord.fileName === "string" ? sourceRecord.fileName : null,
      lineNumber:
        typeof sourceRecord.lineNumber === "number" && Number.isFinite(sourceRecord.lineNumber)
          ? sourceRecord.lineNumber
          : null,
      columnNumber:
        typeof sourceRecord.columnNumber === "number" && Number.isFinite(sourceRecord.columnNumber)
          ? sourceRecord.columnNumber
          : null,
    };
  }

  return {
    id,
    threadId: threadId as ThreadId,
    pickedAt,
    pageUrl,
    pageTitle: typeof candidate.pageTitle === "string" ? candidate.pageTitle : null,
    tagName,
    selector: typeof candidate.selector === "string" ? candidate.selector : null,
    htmlPreview: typeof candidate.htmlPreview === "string" ? candidate.htmlPreview : "",
    componentName: typeof candidate.componentName === "string" ? candidate.componentName : null,
    source,
    styles: typeof candidate.styles === "string" ? candidate.styles : "",
  };
}

function normalizePersistedTerminalContextDraft(
  value: unknown,
): PersistedTerminalContextDraft | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const id = candidate.id;
  const threadId = candidate.threadId;
  const createdAt = candidate.createdAt;
  const lineStart = candidate.lineStart;
  const lineEnd = candidate.lineEnd;

  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof threadId !== "string" ||
    threadId.length === 0 ||
    typeof createdAt !== "string" ||
    createdAt.length === 0 ||
    typeof lineStart !== "number" ||
    !Number.isFinite(lineStart) ||
    typeof lineEnd !== "number" ||
    !Number.isFinite(lineEnd)
  ) {
    return null;
  }

  const terminalId = typeof candidate.terminalId === "string" ? candidate.terminalId.trim() : "";

  const terminalLabel =
    typeof candidate.terminalLabel === "string" ? candidate.terminalLabel.trim() : "";

  if (terminalId.length === 0 || terminalLabel.length === 0) {
    return null;
  }

  const normalizedLineStart = Math.max(1, Math.floor(lineStart));
  const normalizedLineEnd = Math.max(normalizedLineStart, Math.floor(lineEnd));

  return {
    id,
    threadId: threadId as ThreadId,
    createdAt,
    terminalId,
    terminalLabel,
    lineStart: normalizedLineStart,
    lineEnd: normalizedLineEnd,
  };
}

export function normalizePersistedDraftThreads(
  rawDraftThreadsByThreadId: unknown,
  rawProjectDraftThreadIdByProjectKey: unknown,
): Pick<
  PersistedComposerDraftStoreState,
  "draftThreadsByThreadKey" | "logicalProjectDraftThreadKeyByLogicalProjectKey"
> {
  const draftThreadsByThreadKey: Record<string, PersistedDraftThreadState> = {};
  const environmentIdByThreadId = new Map<ThreadId, EnvironmentId>();

  if (
    rawProjectDraftThreadIdByProjectKey &&
    typeof rawProjectDraftThreadIdByProjectKey === "object"
  ) {
    for (const [projectKey, threadId] of Object.entries(
      rawProjectDraftThreadIdByProjectKey as Record<string, unknown>,
    )) {
      if (typeof threadId !== "string" || threadId.length === 0) {
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

      environmentIdByThreadId.set(threadId as ThreadId, projectRef.environmentId);
    }
  }

  if (rawDraftThreadsByThreadId && typeof rawDraftThreadsByThreadId === "object") {
    for (const [threadKeyOrId, rawDraftThread] of Object.entries(
      rawDraftThreadsByThreadId as Record<string, unknown>,
    )) {
      if (typeof threadKeyOrId !== "string" || threadKeyOrId.length === 0) {
        continue;
      }

      if (!rawDraftThread || typeof rawDraftThread !== "object") {
        continue;
      }

      const candidateDraftThread = rawDraftThread as Record<string, unknown>;
      const parsedThreadRef = parseScopedThreadKey(threadKeyOrId);
      const threadKey = normalizeLegacyComposerStorageKey(threadKeyOrId);

      const threadId =
        parsedThreadRef?.threadId ??
        (typeof candidateDraftThread.threadId === "string" &&
        candidateDraftThread.threadId.length > 0
          ? (candidateDraftThread.threadId as ThreadId)
          : (threadKeyOrId as ThreadId));

      const environmentId =
        parsedThreadRef?.environmentId ??
        (typeof candidateDraftThread.environmentId === "string" &&
        candidateDraftThread.environmentId.length > 0
          ? (candidateDraftThread.environmentId as EnvironmentId)
          : environmentIdByThreadId.get(threadKeyOrId as ThreadId));

      const projectId = candidateDraftThread.projectId;
      const createdAt = candidateDraftThread.createdAt;
      const branch = candidateDraftThread.branch;
      const worktreePath = candidateDraftThread.worktreePath;
      const startFromOrigin = candidateDraftThread.startFromOrigin === true;
      const normalizedWorktreePath = typeof worktreePath === "string" ? worktreePath : null;
      const promotedToCandidate = candidateDraftThread.promotedTo;

      const promotedToRecord =
        promotedToCandidate && typeof promotedToCandidate === "object"
          ? (promotedToCandidate as Record<string, unknown>)
          : null;

      const promotedTo =
        promotedToRecord &&
        typeof promotedToRecord.environmentId === "string" &&
        promotedToRecord.environmentId.length > 0 &&
        typeof promotedToRecord.threadId === "string" &&
        promotedToRecord.threadId.length > 0
          ? scopeThreadRef(
              promotedToRecord.environmentId as EnvironmentId,
              promotedToRecord.threadId as ThreadId,
            )
          : null;

      if (typeof projectId !== "string" || projectId.length === 0 || environmentId === undefined) {
        continue;
      }

      const normalizedEnvironmentId = environmentId as EnvironmentId;
      draftThreadsByThreadKey[threadKey] = {
        threadId,
        environmentId: normalizedEnvironmentId,
        projectId: projectId as ProjectId,
        logicalProjectKey:
          typeof candidateDraftThread.logicalProjectKey === "string" &&
          candidateDraftThread.logicalProjectKey.length > 0
            ? candidateDraftThread.logicalProjectKey
            : parsedThreadRef
              ? projectDraftKey(scopeProjectRef(normalizedEnvironmentId, projectId as ProjectId))
              : threadKeyOrId,
        createdAt:
          typeof createdAt === "string" && createdAt.length > 0
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
        branch: typeof branch === "string" ? branch : null,
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
    typeof rawProjectDraftThreadIdByProjectKey === "object"
  ) {
    for (const [logicalProjectKey, threadKeyOrId] of Object.entries(
      rawProjectDraftThreadIdByProjectKey as Record<string, unknown>,
    )) {
      if (typeof threadKeyOrId !== "string" || threadKeyOrId.length === 0) {
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
          threadId: parsedThreadRef?.threadId ?? (threadKey as ThreadId),
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
  rawDraftMap: unknown,
  draftThreadsByThreadKey: PersistedComposerDraftStoreState["draftThreadsByThreadKey"],
): PersistedComposerDraftStoreState["draftsByThreadKey"] {
  if (!rawDraftMap || typeof rawDraftMap !== "object") {
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
      draftThread.environmentId as EnvironmentId,
    );
  }

  const nextDraftsByThreadKey: DeepMutable<PersistedComposerDraftStoreState["draftsByThreadKey"]> =
    {};

  for (const [threadKeyOrId, draftValue] of Object.entries(
    rawDraftMap as Record<string, unknown>,
  )) {
    if (typeof threadKeyOrId !== "string" || threadKeyOrId.length === 0) {
      continue;
    }

    if (!draftValue || typeof draftValue !== "object") {
      continue;
    }

    const draftCandidate = draftValue as PersistedComposerThreadDraftState;
    const promptCandidate = typeof draftCandidate.prompt === "string" ? draftCandidate.prompt : "";

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
    const legacyDraftCandidate = draftValue as LegacyPersistedComposerThreadDraftState;
    let modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>> = {};
    let activeProvider: ProviderInstanceId | null = null;

    if (
      draftCandidate.modelSelectionByProvider &&
      typeof draftCandidate.modelSelectionByProvider === "object"
    ) {
      // v3 format
      modelSelectionByProvider = draftCandidate.modelSelectionByProvider as Partial<
        Record<ProviderInstanceId, ModelSelection>
      >;
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
          modelOptions: normalizedModelOptions ?? (legacyDraftCandidate.modelOptions as unknown),
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
              const environmentId = environmentIdByThreadId.get(threadKeyOrId as ThreadId);

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
