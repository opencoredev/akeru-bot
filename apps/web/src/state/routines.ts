import { createRoutineEnvironmentAtoms } from "@t3tools/client-runtime/state/routines";

import { connectionAtomRuntime } from "../connection/runtime";

export const routineEnvironment = createRoutineEnvironmentAtoms(connectionAtomRuntime);
