import * as Layer from "effect/Layer";

import { RoutineRepositoryLive } from "./RepositoryLive.ts";
import { RoutineRuntimeLive } from "./RuntimeLive.ts";
import { RoutineRuntimeAdapterLive } from "./RuntimeAdapterLive.ts";

export const RoutineLayerLive = RoutineRuntimeLive.pipe(
  Layer.provide(Layer.mergeAll(RoutineRepositoryLive, RoutineRuntimeAdapterLive)),
);
