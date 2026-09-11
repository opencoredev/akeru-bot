import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { DesktopTraceShutdown } from "./DesktopObservability.ts";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

function makeElectronAppLayer(
  appListeners: Map<string, (...args: readonly unknown[]) => void>,
  quit: Effect.Effect<void> = Effect.void,
) {
  const registerListener = (eventName: string, listener: (...args: readonly unknown[]) => void) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        appListeners.set(eventName, listener);
      }),
      () =>
        Effect.sync(() => {
          appListeners.delete(eventName);
        }),
    ).pipe(Effect.asVoid);

  return Layer.succeed(ElectronApp.ElectronApp, {
    metadata: Effect.die("unexpected metadata read"),
    name: Effect.succeed("T3 Code"),
    systemLocale: Effect.succeed("en-US"),
    whenReady: Effect.void,
    quit,
    requestSingleInstanceLock: Effect.succeed(true),
    exit: () => Effect.void,
    relaunch: () => Effect.void,
    setPath: () => Effect.void,
    setName: () => Effect.void,
    setAboutPanelOptions: () => Effect.void,
    setAppUserModelId: () => Effect.void,
    getAppMetrics: Effect.succeed([]),
    isDefaultProtocolClient: () => Effect.succeed(false),
    setAsDefaultProtocolClient: () => Effect.succeed(true),
    setDesktopName: () => Effect.void,
    setDockIcon: () => Effect.void,
    appendCommandLineSwitch: () => Effect.void,
    removeCommandLineSwitch: () => Effect.void,
    onBeforeQuitForUpdate: (listener) => registerListener("before-quit-for-update", listener),
    on: (eventName, listener) =>
      registerListener(eventName, listener as unknown as (...args: readonly unknown[]) => void),
  } satisfies ElectronApp.ElectronApp["Service"]);
}

const electronThemeLayer = Layer.succeed(ElectronTheme.ElectronTheme, {
  shouldUseDarkColors: Effect.succeed(false),
  setSource: () => Effect.void,
  onUpdated: () => Effect.void,
});

function makeElectronWindowLayer(destroyAll: Effect.Effect<void> = Effect.void) {
  return Layer.succeed(ElectronWindow.ElectronWindow, {
    create: () => Effect.die("unexpected window creation"),
    main: Effect.die("unexpected main window read"),
    currentMainOrFirst: Effect.die("unexpected current window read"),
    focusedMainOrFirst: Effect.die("unexpected focused window read"),
    setMain: () => Effect.void,
    clearMain: () => Effect.void,
    reveal: () => Effect.void,
    sendAll: () => Effect.void,
    destroyAll,
    syncAllAppearance: () => Effect.void,
  });
}

function makeDesktopWindowLayer(
  input: {
    readonly activate?: Effect.Effect<void>;
    readonly flushMainWindowBounds?: Effect.Effect<void>;
  } = {},
) {
  return Layer.succeed(DesktopWindow.DesktopWindow, {
    createMain: Effect.die("unexpected window creation"),
    ensureMain: Effect.die("unexpected window creation"),
    revealOrCreateMain: Effect.die("unexpected window creation"),
    activate: input.activate ?? Effect.void,
    createMainIfBackendReady: Effect.void,
    showConnectingSplash: Effect.void,
    handleBackendReady: () => Effect.void,
    handleBackendNotReady: Effect.void,
    flushMainWindowBounds: input.flushMainWindowBounds ?? Effect.void,
    dispatchMenuAction: () => Effect.void,
    zoomMain: () => Effect.void,
    syncAppearance: Effect.void,
  });
}

describe("DesktopLifecycle", () => {
  for (const platform of ["darwin", "win32", "linux"] satisfies ReadonlyArray<NodeJS.Platform>) {
    it.effect(`lets the updater's quit event proceed on ${platform}`, () => {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      const environmentLayer = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
        platform,
        isDevelopment: false,
      } as DesktopEnvironment.DesktopEnvironment["Service"]);

      const layer = DesktopLifecycle.layer.pipe(
        Layer.provideMerge(makeElectronAppLayer(appListeners)),
        Layer.provideMerge(electronThemeLayer),
        Layer.provideMerge(makeElectronWindowLayer()),
        Layer.provideMerge(makeDesktopWindowLayer()),
        Layer.provideMerge(environmentLayer),
        Layer.provideMerge(DesktopShutdown.layer),
        Layer.provideMerge(DesktopState.layer),
      );

      return Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.register;

          appListeners.get("before-quit-for-update")?.();

          let prevented = false;
          const event = {
            preventDefault: () => {
              prevented = true;
            },
          } as Electron.Event;
          appListeners.get("before-quit")?.(event);

          assert.isFalse(
            prevented,
            "cancelling this event prevents the updater from completing its relaunch",
          );

          const state = yield* DesktopState.DesktopState;
          assert.isTrue(yield* Ref.get(state.quitting));
        }),
      ).pipe(Effect.provide(layer));
    });
  }

  it.effect("keeps windows alive until shutdown acknowledgement", () =>
    Effect.gen(function* () {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      const shutdownRequested = yield* Deferred.make<void>();
      const allowShutdown = yield* Deferred.make<void>();
      const quitRequested = yield* Deferred.make<void>();
      const events: string[] = [];

      const quit = Effect.sync(() => {
        events.push("quit");
      }).pipe(Effect.andThen(Deferred.succeed(quitRequested, undefined)), Effect.asVoid);
      const destroyAll = Effect.sync(() => {
        events.push("destroy");
      });
      const flushMainWindowBounds = Effect.sync(() => {
        events.push("flush");
      });

      const desktopShutdownLayer = Layer.succeed(DesktopShutdown.DesktopShutdown, {
        request: Effect.sync(() => {
          events.push("request");
        }).pipe(Effect.andThen(Deferred.succeed(shutdownRequested, undefined)), Effect.asVoid),
        awaitRequest: Deferred.await(shutdownRequested),
        markComplete: Deferred.succeed(allowShutdown, undefined).pipe(Effect.asVoid),
        awaitComplete: Deferred.await(allowShutdown),
        isComplete: Deferred.isDone(allowShutdown),
      });

      const environmentLayer = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
        platform: "darwin",
        isDevelopment: false,
      } as DesktopEnvironment.DesktopEnvironment["Service"]);

      const layer = DesktopLifecycle.layer.pipe(
        Layer.provideMerge(makeElectronAppLayer(appListeners, quit)),
        Layer.provideMerge(electronThemeLayer),
        Layer.provideMerge(makeElectronWindowLayer(destroyAll)),
        Layer.provideMerge(makeDesktopWindowLayer({ flushMainWindowBounds })),
        Layer.provideMerge(environmentLayer),
        Layer.provideMerge(desktopShutdownLayer),
        Layer.provideMerge(DesktopState.layer),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.register;

          const event = { preventDefault: () => undefined } as Electron.Event;
          appListeners.get("before-quit")?.(event);

          yield* Deferred.await(shutdownRequested);
          const eventsBeforeCleanup = [...events];
          yield* Deferred.succeed(allowShutdown, undefined);
          yield* Deferred.await(quitRequested);

          assert.deepEqual(eventsBeforeCleanup, ["flush", "request"]);
          assert.deepEqual(events, ["flush", "request", "destroy", "quit"]);
        }),
      ).pipe(Effect.provide(layer));
    }),
  );

  for (const destroyFails of [false, true]) {
    it.effect(
      `completes nested app shutdown before native quit (destroyFails=${destroyFails})`,
      () =>
        Effect.gen(function* () {
          const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
          const registered = yield* Deferred.make<void>();
          const boundsEntered = yield* Deferred.make<void>();
          const allowBounds = yield* Deferred.make<void>();
          const stopEntered = yield* Deferred.make<void>();
          const allowStop = yield* Deferred.make<void>();
          const closeEntered = yield* Deferred.make<void>();
          const allowClose = yield* Deferred.make<void>();
          const nativeQuit = yield* Deferred.make<void>();
          const events: string[] = [];
          const quit = Effect.sync(() => {
            events.push("native-quit");
          }).pipe(Effect.andThen(Deferred.succeed(nativeQuit, undefined)), Effect.asVoid);
          const layer = Layer.mergeAll(
            DesktopLifecycle.layer,
            makeElectronAppLayer(appListeners, quit),
            electronThemeLayer,
            makeElectronWindowLayer(
              Effect.sync(() => {
                events.push("destroy");
                if (destroyFails) throw new Error("invalid guest");
              }),
            ),
            makeDesktopWindowLayer({
              flushMainWindowBounds: Effect.gen(function* () {
                events.push("bounds");
                yield* Deferred.succeed(boundsEntered, undefined);
                yield* Deferred.await(allowBounds);
              }),
            }),
            Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
              platform: "linux",
              isDevelopment: false,
            } as DesktopEnvironment.DesktopEnvironment["Service"]),
            DesktopShutdown.layer,
            DesktopState.layer,
            Layer.succeed(DesktopTraceShutdown, {
              close: Effect.gen(function* () {
                events.push("trace-close");
                assert.isFalse(appListeners.has("before-quit"));
                yield* Deferred.succeed(closeEntered, undefined);
                yield* Deferred.await(allowClose);
                events.push("trace-ack");
              }),
            }),
            Layer.effectDiscard(Effect.addFinalizer(() => Deferred.await(nativeQuit))),
          );
          const main = yield* Effect.scoped(
            Effect.gen(function* () {
              const shutdown = yield* DesktopShutdown.DesktopShutdown;
              yield* Effect.addFinalizer(() =>
                Effect.gen(function* () {
                  events.push("backend-stop");
                  yield* Deferred.succeed(stopEntered, undefined);
                  yield* Deferred.await(allowStop);
                }),
              );
              const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
              yield* lifecycle.register;
              yield* Deferred.succeed(registered, undefined);
              yield* shutdown.awaitRequest;
            }),
          ).pipe(
            Effect.withSpan("desktop.app"),
            Effect.ensuring(DesktopShutdown.acknowledgeShutdown),
            Effect.provide(layer),
            Effect.forkChild,
          );
          yield* Deferred.await(registered);
          let prevented = false;
          appListeners.get("before-quit")?.({
            preventDefault: () => {
              prevented = true;
            },
          });
          yield* Deferred.await(boundsEntered);
          assert.isTrue(prevented);
          assert.isFalse(yield* Deferred.isDone(stopEntered));
          yield* Deferred.succeed(allowBounds, undefined);
          yield* Deferred.await(stopEntered);
          const beforeBackendAcknowledgement = [...events];
          assert.isFalse(yield* Deferred.isDone(closeEntered));
          yield* Deferred.succeed(allowStop, undefined);
          yield* Deferred.await(closeEntered);
          const beforeTraceAcknowledgement = [...events];
          assert.isFalse(yield* Deferred.isDone(nativeQuit));
          yield* Deferred.succeed(allowClose, undefined);
          yield* Deferred.await(nativeQuit);
          yield* Fiber.join(main);
          assert.deepEqual(beforeBackendAcknowledgement, ["bounds", "backend-stop"]);
          assert.deepEqual(beforeTraceAcknowledgement, ["bounds", "backend-stop", "trace-close"]);
          assert.deepEqual(events, [
            "bounds",
            "backend-stop",
            "trace-close",
            "trace-ack",
            "destroy",
            "native-quit",
          ]);
        }),
    );
  }

  it.effect("ignores app activation while quitting", () =>
    Effect.gen(function* () {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      let activationCount = 0;
      const activate = Effect.sync(() => {
        activationCount += 1;
      });
      const environmentLayer = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
        platform: "darwin",
        isDevelopment: false,
      } as DesktopEnvironment.DesktopEnvironment["Service"]);
      const layer = DesktopLifecycle.layer.pipe(
        Layer.provideMerge(makeElectronAppLayer(appListeners)),
        Layer.provideMerge(electronThemeLayer),
        Layer.provideMerge(makeElectronWindowLayer()),
        Layer.provideMerge(makeDesktopWindowLayer({ activate })),
        Layer.provideMerge(environmentLayer),
        Layer.provideMerge(DesktopShutdown.layer),
        Layer.provideMerge(DesktopState.layer),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          const state = yield* DesktopState.DesktopState;
          yield* lifecycle.register;
          yield* Ref.set(state.quitting, true);

          appListeners.get("activate")?.();

          assert.equal(activationCount, 0);
        }),
      ).pipe(Effect.provide(layer));
    }),
  );
});
