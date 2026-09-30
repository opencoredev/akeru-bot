import type { AppStateStatus } from "react-native";
import { AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({ AppState: { addEventListener: () => ({ remove: () => {} }) } }));

import { createAppFocusSignalAtom } from "./appFocusSignal";

function harness() {
  const listeners: Array<(status: AppStateStatus) => void> = [];
  let unsubscribed = 0;
  const atom = createAppFocusSignalAtom((listener) => {
    listeners.push(listener);
    return () => {
      unsubscribed += 1;
    };
  });
  const registry = AtomRegistry.make();
  const seen: number[] = [];
  const unmount = registry.subscribe(atom, (value) => seen.push(value), { immediate: true });
  return {
    seen,
    emit: (status: AppStateStatus) => {
      for (const listener of listeners) listener(status);
    },
    unmount,
    dispose: () => registry.dispose(),
    unsubscribedCount: () => unsubscribed,
  };
}

describe("app focus signal", () => {
  it("starts at zero and counts each return to the foreground", () => {
    const app = harness();
    expect(app.seen).toEqual([0]);
    app.emit("active");
    app.emit("active");
    expect(app.seen).toEqual([0, 1, 2]);
    app.dispose();
  });

  it("emits nothing while the app is backgrounded", () => {
    const app = harness();
    app.emit("background");
    app.emit("background");
    expect(app.seen).toEqual([0]);
    // Coming back is one signal, not one per state change while away.
    app.emit("active");
    expect(app.seen).toEqual([0, 1]);
    app.dispose();
  });

  it("does not treat the transient inactive state as a return", () => {
    const app = harness();
    app.emit("inactive");
    expect(app.seen).toEqual([0]);
    // iOS passes through inactive on the way back; only active counts.
    app.emit("active");
    expect(app.seen).toEqual([0, 1]);
    app.dispose();
  });

  it("stops listening once nothing reads it", () => {
    const app = harness();
    app.unmount();
    app.dispose();
    expect(app.unsubscribedCount()).toBe(1);
  });
});
