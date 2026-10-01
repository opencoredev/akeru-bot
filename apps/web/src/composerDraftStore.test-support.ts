import * as Predicate from "effect/Predicate";
import { scopedThreadKey, scopeThreadRef } from "@akeru/client-runtime/environment";
import {
  defaultInstanceIdForDriver,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type ProviderOptionSelection,
} from "@akeru/contracts";
import { createModelSelection } from "@akeru/shared/model";
import { vi } from "vite-plus/test";
import { type ComposerImageAttachment, useComposerDraftStore } from "./composerDraftStore";
import { type TerminalContextDraft } from "./lib/terminalContext";

// The composer draft's `modelSelectionByProvider` and
// `stickyModelSelectionByProvider` maps are keyed by `ProviderInstanceId`
// in production; these aliases keep the legacy-key migration tests concise.
export const CODEX_INSTANCE = ProviderInstanceId.make("codex");

export const CODEX_SECONDARY_INSTANCE = ProviderInstanceId.make("codex_secondary");

export const CLAUDE_AGENT_INSTANCE = ProviderInstanceId.make("claudeAgent");

export const CURSOR_INSTANCE = ProviderInstanceId.make("cursor");

export const CODEX_DRIVER = ProviderDriverKind.make("codex");

export const CLAUDE_AGENT_DRIVER = ProviderDriverKind.make("claudeAgent");

export const CURSOR_DRIVER = ProviderDriverKind.make("cursor");

type ProviderOptionSelectionBag = ReadonlyArray<ProviderOptionSelection>;

type ProviderOptionSelectionsByProvider = Partial<Record<string, ProviderOptionSelectionBag>>;

export function toSelections(
  options: Record<string, string | boolean | undefined> | undefined,
): ReadonlyArray<ProviderOptionSelection> {
  const result: Array<ProviderOptionSelection> = [];

  if (!options) return result;

  for (const [id, value] of Object.entries(options)) {
    if (Predicate.isString(value) || Predicate.isBoolean(value)) {
      result.push({ id, value });
    }
  }

  return result;
}

function selectionsByProvider(
  options: Partial<Record<ProviderDriverKind, Record<string, string | boolean | undefined>>>,
) {
  const result: ProviderOptionSelectionsByProvider = {};

  for (const [provider, bag] of Object.entries(options)) {
    result[ProviderDriverKind.make(provider)] = toSelections(bag);
  }

  return result;
}

export function makeImage(input: {
  id: string;
  previewUrl: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  lastModified?: number;
}): ComposerImageAttachment {
  const name = input.name ?? "image.png";
  const mimeType = input.mimeType ?? "image/png";
  const sizeBytes = input.sizeBytes ?? 4;
  const lastModified = input.lastModified ?? 1_700_000_000_000;

  const file = new File([new Uint8Array(sizeBytes).fill(1)], name, {
    type: mimeType,
    lastModified,
  });

  return {
    type: "image",
    id: input.id,
    name,
    mimeType,
    sizeBytes: file.size,
    previewUrl: input.previewUrl,
    file,
  };
}

export function makeTerminalContext(input: {
  id: string;
  text?: string;
  terminalId?: string;
  terminalLabel?: string;
  lineStart?: number;
  lineEnd?: number;
}): TerminalContextDraft {
  return {
    id: input.id,
    threadId: ThreadId.make("thread-dedupe"),
    terminalId: input.terminalId ?? "default",
    terminalLabel: input.terminalLabel ?? "Terminal 1",
    lineStart: input.lineStart ?? 4,
    lineEnd: input.lineEnd ?? 5,
    text: input.text ?? "git status\nOn branch main",
    createdAt: "2026-03-13T12:00:00.000Z",
  };
}

export function resetComposerDraftStore() {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
}

export function modelSelection(
  provider: ProviderDriverKind,
  model: string,
  options?: Record<string, string | boolean | undefined>,
): ModelSelection {
  return createModelSelection(defaultInstanceIdForDriver(provider), model, toSelections(options));
}

export function providerModelOptions(
  options: Partial<Record<string, Record<string, string | boolean | undefined>>>,
) {
  return selectionsByProvider(options);
}

export const TEST_ENVIRONMENT_ID = EnvironmentId.make("environment-local");

export const OTHER_TEST_ENVIRONMENT_ID = EnvironmentId.make("environment-remote");

const LEGACY_TEST_ENVIRONMENT_ID = EnvironmentId.make("__legacy__");

export function threadKeyFor(
  threadId: ThreadId,
  environmentId: EnvironmentId = LEGACY_TEST_ENVIRONMENT_ID,
): string {
  if (environmentId === LEGACY_TEST_ENVIRONMENT_ID) {
    return threadId;
  }

  return scopedThreadKey(scopeThreadRef(environmentId, threadId));
}

export function draftFor(
  threadId: ThreadId,
  environmentId: EnvironmentId = LEGACY_TEST_ENVIRONMENT_ID,
) {
  const store = useComposerDraftStore.getState().draftsByThreadKey;

  return store[threadKeyFor(threadId, environmentId)] ?? store[threadId] ?? undefined;
}

export function draftByKey(key: string) {
  return useComposerDraftStore.getState().draftsByThreadKey[key] ?? undefined;
}

// ---------------------------------------------------------------------------
// createDebouncedStorage
// ---------------------------------------------------------------------------

export function createMockStorage() {
  const store = new Map<string, string>();

  return {
    getItem: vi.fn((name: string) => store.get(name) ?? null),
    setItem: vi.fn((name: string, value: string) => {
      store.set(name, value);
    }),
    removeItem: vi.fn((name: string) => {
      store.delete(name);
    }),
  };
}
