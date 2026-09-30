import { createComputerEnvironmentAtoms } from "@t3tools/client-runtime/state/computer";

import { connectionAtomRuntime } from "../connection/runtime";

export const computerEnvironment = createComputerEnvironmentAtoms(connectionAtomRuntime);
