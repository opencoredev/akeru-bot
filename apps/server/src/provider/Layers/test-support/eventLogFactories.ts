import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as EventLog from "../EventNdjsonLogger.ts";

export const makeEventNdjsonLogStore = (
  ...args: Parameters<typeof EventLog.makeEventNdjsonLogStore>
) => EventLog.makeEventNdjsonLogStore(...args).pipe(Effect.provide(NodePath.layer));

export const makeEventNdjsonLogger = (...args: Parameters<typeof EventLog.makeEventNdjsonLogger>) =>
  EventLog.makeEventNdjsonLogger(...args).pipe(Effect.provide(NodePath.layer));
