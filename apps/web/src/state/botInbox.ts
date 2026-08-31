import { createBotInboxEnvironmentAtoms } from "@t3tools/client-runtime/state/bot-inbox";

import { connectionAtomRuntime } from "../connection/runtime";

export const botInboxEnvironment = createBotInboxEnvironmentAtoms(connectionAtomRuntime);
