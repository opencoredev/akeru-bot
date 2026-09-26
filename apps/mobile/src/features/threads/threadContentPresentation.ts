import { type EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";

export type ThreadContentPresentation =
  | { readonly kind: "ready" }
  | { readonly kind: "loading" }
  | {
      readonly kind: "unavailable";
      readonly title: string;
      readonly detail: string;
    };

// Shared instances keep the presentation referentially stable across renders,
// so memoized consumers such as the thread feed skip unrelated re-renders.
const READY: ThreadContentPresentation = { kind: "ready" };
const LOADING: ThreadContentPresentation = { kind: "loading" };
const DELETED: ThreadContentPresentation = {
  kind: "unavailable",
  title: "Chat unavailable",
  detail: "This chat was deleted or is no longer available.",
};
const NOT_CACHED: ThreadContentPresentation = {
  kind: "unavailable",
  title: "Messages not cached",
  detail: "Reconnect this environment to load the conversation.",
};
const detailErrorPresentations = new Map<string, ThreadContentPresentation>();

export function projectThreadContentPresentation(input: {
  readonly hasDetail: boolean;
  readonly detailError: string | null;
  readonly detailDeleted: boolean;
  readonly connectionState: EnvironmentConnectionPhase;
}): ThreadContentPresentation {
  if (input.hasDetail) {
    return READY;
  }
  if (input.detailDeleted) {
    return DELETED;
  }
  if (input.detailError !== null) {
    let presentation = detailErrorPresentations.get(input.detailError);
    if (presentation === undefined) {
      presentation = {
        kind: "unavailable",
        title: "Could not load conversation",
        detail: input.detailError,
      };
      // Error text is unbounded; keep only the latest to avoid a slow leak.
      detailErrorPresentations.clear();
      detailErrorPresentations.set(input.detailError, presentation);
    }
    return presentation;
  }
  if (
    input.connectionState === "connected" ||
    input.connectionState === "connecting" ||
    input.connectionState === "reconnecting"
  ) {
    // Messages will arrive once the (re)connection completes — present as
    // loading; the composer's connection pill reports the connection phase.
    return LOADING;
  }
  return NOT_CACHED;
}
