import { createMemoryEnvironmentAtoms } from "@t3tools/client-runtime/state/memory";

import { connectionAtomRuntime } from "../connection/runtime";

export const memoryEnvironment = createMemoryEnvironmentAtoms(connectionAtomRuntime);
