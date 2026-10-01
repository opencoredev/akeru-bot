import { webContents } from "electron";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";

import * as DateTime from "effect/DateTime";

import * as Effect from "effect/Effect";

import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import type * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";

import {
  type PreviewOperationContext,
  PreviewTabNotFoundError,
  PreviewWebContentsNotFoundError,
  PreviewWebviewNotInitializedError,
  PreviewOperationError,
  PreviewArtifactPathOutsideDirectoryError,
} from "./PreviewErrors.ts";

import { type PreviewTabState, encodeUnknownJson, type Listener } from "./PreviewModel.ts";

export const createPreviewState = ({
  listenersRef,
  tabsRef,
  path,
  resolvedArtifactDirectory,
}: {
  readonly listenersRef: Ref.Ref<ReadonlySet<Listener>>;
  readonly tabsRef: SynchronizedRef.SynchronizedRef<ReadonlyMap<string, PreviewTabState>>;
  readonly path: Path.Path;
  readonly resolvedArtifactDirectory: string;
}) => {
  const attempt = <A>(errorContext: PreviewOperationContext, evaluate: () => A) =>
    Effect.try({
      try: evaluate,
      catch: (cause) => new PreviewOperationError({ ...errorContext, cause }),
    });

  const attemptPromise = <A>(
    errorContext: PreviewOperationContext,
    evaluate: () => PromiseLike<A>,
  ) =>
    Effect.tryPromise({
      try: evaluate,
      catch: (cause) => new PreviewOperationError({ ...errorContext, cause }),
    });

  const currentIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const currentMillis = Clock.currentTimeMillis;

  const encodeJson = <T>(errorContext: PreviewOperationContext, value: T) =>
    encodeUnknownJson(value).pipe(
      Effect.mapError((cause) => new PreviewOperationError({ ...errorContext, cause })),
    );

  const nextCounter = (ref: Ref.Ref<number>) =>
    Ref.modify(ref, (value) => [value, value + 1] as const);

  const replaceMap = <K, V>(
    source: ReadonlyMap<K, V>,
    update: (copy: Map<K, V>) => void,
  ): ReadonlyMap<K, V> => {
    const copy = new Map(source);
    update(copy);

    return copy;
  };

  const deliverEvent = (
    eventKind: "state-change" | "recording-frame" | "pointer-event",
    tabId: string,
    delivery: () => Effect.Effect<void>,
  ) =>
    Effect.suspend(delivery).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("Desktop preview event listener failed.", {
              eventKind,
              tabId,
              cause,
            }),
      ),
    );

  const emit = Effect.fn("PreviewManager.emit")(function* (tabId: string, state: PreviewTabState) {
    const listeners = yield* Ref.get(listenersRef);
    yield* Effect.forEach(
      listeners,
      (listener) => deliverEvent("state-change", tabId, () => listener(tabId, state)),
      { discard: true },
    );
  });

  const emitIfCurrent = Effect.fn("PreviewManager.emitIfCurrent")(function* (
    tabId: string,
    state: PreviewTabState,
  ) {
    if ((yield* SynchronizedRef.get(tabsRef)).get(tabId) === state) {
      yield* emit(tabId, state);
    }
  });

  const update = Effect.fn("PreviewManager.update")(function* (
    tabId: string,
    patch: Partial<PreviewTabState>,
  ) {
    const updatedAt = yield* currentIso;

    const next = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
      const current = tabs.get(tabId);

      if (!current) return [Option.none<PreviewTabState>(), tabs] as const;
      const state: PreviewTabState = { ...current, ...patch, updatedAt };

      return [
        Option.some(state),
        replaceMap(tabs, (copy) => {
          copy.set(tabId, state);
        }),
      ] as const;
    });

    // emitIfCurrent, not emit: an event-driven writer such as syncTabAudible
    // can commit between the modify above and here, and republishing this
    // snapshot would roll the UI back to a value that writer will not send
    // again because it suppresses unchanged audibility.
    if (Option.isSome(next)) yield* emitIfCurrent(tabId, next.value);
  });

  /**
   * Pushes a tab's zoom factor onto whichever guest it currently owns, reading
   * both at call time. Anything that applies zoom after an await goes through
   * here: a snapshot taken before the await can be older than a zoom action that
   * landed in between, and re-applying it would roll that action back.
   */
  const assertTabZoom = Effect.fn("PreviewManager.assertTabZoom")(function* (tabId: string) {
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);

    if (!tab || tab.webContentsId == null) return;
    const wc = webContents.fromId(tab.webContentsId);

    if (!wc || wc.isDestroyed()) return;
    yield* attempt({ operation: "assertTabZoom", tabId, webContentsId: wc.id }, () =>
      wc.setZoomFactor(tab.zoomFactor),
    ).pipe(Effect.ignore);
  });

  /**
   * Mute counterpart to {@link assertTabZoom}: pushes the tab's committed mute
   * onto whichever guest it currently owns, reading both at call time so an
   * older snapshot can never roll back a mute action that landed after it.
   *
   * Failures propagate so the user-facing setter can roll its commit back.
   * Reconciliation callers, where a guest going away mid-attach is expected,
   * discard the error at their own call site.
   */
  const assertTabAudioMuted = Effect.fn("PreviewManager.assertTabAudioMuted")(function* (
    tabId: string,
  ) {
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);

    if (!tab || tab.webContentsId == null) return;
    const wc = webContents.fromId(tab.webContentsId);

    if (!wc || wc.isDestroyed()) return;
    yield* attempt({ operation: "assertTabAudioMuted", tabId, webContentsId: wc.id }, () =>
      wc.setAudioMuted(tab.audioMuted),
    );
  });

  /**
   * Publishes an observed audibility value for the guest that reported it.
   * Shared by the `audio-state-changed` handler and the post-attach reconcile
   * so both drop values from a guest the tab no longer owns, and both skip
   * unchanged values: Chromium re-emits per media element, and republishing
   * would cost an IPC push per element rather than per real transition.
   */
  const syncTabAudible = Effect.fn("PreviewManager.syncTabAudible")(function* (
    tabId: string,
    wc: Electron.WebContents,
    audible: boolean,
  ) {
    if (wc.isDestroyed()) return;
    const updatedAt = yield* currentIso;

    const next = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
      const current = tabs.get(tabId);

      if (
        !current ||
        current.webContentsId !== wc.id ||
        webContents.fromId(wc.id) !== wc ||
        current.audible === audible
      ) {
        return [Option.none<PreviewTabState>(), tabs] as const;
      }

      const state: PreviewTabState = { ...current, audible, updatedAt };

      return [
        Option.some(state),
        replaceMap(tabs, (copy) => {
          copy.set(tabId, state);
        }),
      ] as const;
    });

    if (Option.isSome(next)) yield* emitIfCurrent(tabId, next.value);
  });

  const requireWebContents = Effect.fn("PreviewManager.requireWebContents")(function* (
    tabId: string,
  ) {
    const tabs = yield* SynchronizedRef.get(tabsRef);
    const tab = tabs.get(tabId);

    if (!tab) {
      return yield* new PreviewTabNotFoundError({ tabId });
    }

    if (tab.webContentsId == null) {
      return yield* new PreviewWebviewNotInitializedError({ tabId });
    }

    const wc = webContents.fromId(tab.webContentsId);

    if (!wc) {
      return yield* new PreviewWebContentsNotFoundError({
        tabId,
        webContentsId: tab.webContentsId,
      });
    }

    return wc;
  });

  const resolveArtifactPath = (artifactPath: string) =>
    attempt({ operation: "resolveArtifactPath", artifactPath }, () => {
      const resolvedPath = path.resolve(artifactPath);
      const relativePath = path.relative(resolvedArtifactDirectory, resolvedPath);

      if (
        relativePath.length === 0 ||
        relativePath === ".." ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)
      ) {
        return null;
      }

      return resolvedPath;
    }).pipe(
      Effect.flatMap((resolvedPath) =>
        resolvedPath === null
          ? Effect.fail(
              new PreviewArtifactPathOutsideDirectoryError({
                artifactPath,
                artifactDirectory: resolvedArtifactDirectory,
              }),
            )
          : Effect.succeed(resolvedPath),
      ),
    );

  const tabIdForWebContents = Effect.fnUntraced(function* (webContentsId: number) {
    const tabs = yield* SynchronizedRef.get(tabsRef);

    return (
      Array.from(tabs.entries()).find(([, tab]) => tab.webContentsId === webContentsId)?.[0] ?? null
    );
  });

  const subscribe = <A>(
    ref: Ref.Ref<ReadonlySet<A>>,
    listener: A,
  ): Effect.Effect<void, never, Scope.Scope> =>
    Effect.acquireRelease(
      Ref.update(ref, (listeners) => new Set([...listeners, listener])),
      () =>
        Ref.update(ref, (listeners) => {
          const next = new Set(listeners);
          next.delete(listener);

          return next;
        }),
    ).pipe(Effect.asVoid);

  return {
    attempt,
    attemptPromise,
    currentIso,
    currentMillis,
    encodeJson,
    nextCounter,
    replaceMap,
    deliverEvent,
    emit,
    emitIfCurrent,
    update,
    assertTabZoom,
    assertTabAudioMuted,
    syncTabAudible,
    requireWebContents,
    resolveArtifactPath,
    tabIdForWebContents,
    subscribe,
  };
};
