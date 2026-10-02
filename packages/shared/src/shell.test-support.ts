import * as Effect from "effect/Effect";
import {
  CommandAvailability,
  type CommandAvailabilityChecker,
  WindowsShellEnvironment,
  type WindowsShellEnvironmentReader,
} from "./shell.ts";

export const withWindowsEnvironmentMocks = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  readEnvironment: WindowsShellEnvironmentReader,
  commandAvailable: CommandAvailabilityChecker,
) =>
  effect.pipe(
    Effect.provideService(WindowsShellEnvironment, readEnvironment),
    Effect.provideService(CommandAvailability, commandAvailable),
  );
