/**
 * Per-bot usage state.
 *
 * Mirror of `apps/web/src/state/botUsage.ts` over mobile's atom wiring, so both
 * clients read the same `bot.usage` query. The query does not poll: it reads
 * again when the app returns to the foreground, when the screen is focused, and
 * on pull-to-refresh.
 *
 * @module state/botUsage
 */
import { createBotUsageEnvironmentAtoms } from "@t3tools/client-runtime/state/bot-usage";

import { connectionAtomRuntime } from "../connection/runtime";
import { appFocusSignalAtom } from "./appFocusSignal";

export const botUsageEnvironment = createBotUsageEnvironmentAtoms(connectionAtomRuntime, {
  focusSignal: appFocusSignalAtom,
});
