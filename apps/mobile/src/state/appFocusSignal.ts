/**
 * Foreground signal.
 *
 * Queries that should read again when the user comes back — rather than poll at
 * a fixed interval whether anyone is looking or not — subscribe to this. It
 * counts returns to the foreground: `background` and `inactive` emit nothing, so
 * a backgrounded app makes no requests at all.
 *
 * `inactive` is the transient iOS state behind the app switcher, a notification
 * shade or a system prompt. Treating it as a return would fire twice for one
 * switch, because iOS passes through it on the way back to `active`.
 *
 * @module state/appFocusSignal
 */
import { Atom } from "effect/unstable/reactivity";
import { AppState, type AppStateStatus } from "react-native";

export type AppStateSubscribe = (listener: (status: AppStateStatus) => void) => () => void;

const subscribeToAppState: AppStateSubscribe = (listener) => {
  const subscription = AppState.addEventListener("change", listener);
  return () => subscription.remove();
};

/**
 * Increments on every transition into the foreground. Exported for tests, which
 * drive it with their own subscribe so no native module is involved.
 */
export function createAppFocusSignalAtom(subscribe: AppStateSubscribe): Atom.Atom<number> {
  return Atom.readable<number>((get) => {
    let count = 0;
    const unsubscribe = subscribe((status) => {
      if (status !== "active") return;
      count += 1;
      get.setSelf(count);
    });
    get.addFinalizer(unsubscribe);
    return count;
  }).pipe(Atom.withLabel("mobile-app-focus-signal"));
}

export const appFocusSignalAtom = createAppFocusSignalAtom(subscribeToAppState);
