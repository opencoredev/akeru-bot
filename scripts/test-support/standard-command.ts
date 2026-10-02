import { ChildProcess } from "effect/unstable/process";

/** Fixtures in these suites spawn a single executable, never a pipeline. */
export function standardCommand(command: ChildProcess.Command) {
  if (!ChildProcess.isStandardCommand(command)) throw new Error("Expected a standard command");

  return command;
}
