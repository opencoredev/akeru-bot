import { createBotUsageEnvironmentAtoms } from "@t3tools/client-runtime/state/bot-usage";

import { connectionAtomRuntime } from "../connection/runtime";

export const botUsageEnvironment = createBotUsageEnvironmentAtoms(connectionAtomRuntime);
