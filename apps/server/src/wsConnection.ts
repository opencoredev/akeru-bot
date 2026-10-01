import * as Effect from "effect/Effect";
import { createWsServices } from "./wsServices.ts";
import { createWsOrchestrationStreams } from "./wsOrchestrationStreams.ts";
import { createWsOrchestrationCommands } from "./wsOrchestrationCommands.ts";
export const createWsConnection = (...args: Parameters<typeof createWsServices>) => Effect.gen(function* () {
const services = yield* createWsServices(...args);
return { ...services, ...createWsOrchestrationStreams(services), ...createWsOrchestrationCommands(services) };
});
export type WsConnection = Effect.Success<ReturnType<typeof createWsConnection>>;
