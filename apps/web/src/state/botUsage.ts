import { createBotUsageEnvironmentAtoms } from "@t3tools/client-runtime/state/bot-usage";
import { Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

// Usage revalidates when the tab becomes visible again, and costs nothing while
// it is hidden.
export const botUsageEnvironment = createBotUsageEnvironmentAtoms(connectionAtomRuntime, {
  focusSignal: Atom.windowFocusSignal,
});
