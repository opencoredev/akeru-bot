import { scopeThreadRef } from "@akeru/client-runtime/environment";
import {
  type EnvironmentId,
  type PreviewEvent,
  type PreviewSessionSnapshot,
  ThreadId,
} from "@akeru/contracts";
import {
  applyPreviewServerEvent as applyPreviewServerEventImpl,
  resetPreviewStateForTests,
} from "./previewStateStore";

const environmentId = "env-1" as EnvironmentId;

export const ref = scopeThreadRef(environmentId, ThreadId.make("thread-1"));

export const otherRef = scopeThreadRef(environmentId, ThreadId.make("thread-2"));

export const makeSnapshot = (
  overrides: Partial<PreviewSessionSnapshot> = {},
): PreviewSessionSnapshot => ({
  threadId: "thread-1",
  tabId: "tab_a",
  navStatus: { _tag: "Loading", url: "http://localhost:5173/", title: "" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

type PreviewEventDraft = PreviewEvent extends infer Event
  ? Event extends { readonly revision: number }
    ? Omit<Event, "revision" | "serverEpoch">
    : never
  : never;

export const serverEpoch = "server-a";

let nextServerRevision = 0;

export const applyPreviewServerEvent = (eventRef: typeof ref, event: PreviewEventDraft): void => {
  nextServerRevision += 1;
  applyPreviewServerEventImpl(eventRef, {
    ...event,
    serverEpoch,
    revision: nextServerRevision,
  } as PreviewEvent);
};

export function resetPreviewTestFixtures() {
  nextServerRevision = 0;
  resetPreviewStateForTests();
}
