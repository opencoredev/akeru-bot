import type { EnvironmentThreadShell } from "@akeru/client-runtime/state/shell";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentServerConfigsAtom } from "../../state/server";

export type ThreadCapability =
  | "threadSettlement"
  | "threadSnooze"
  | "threadPinning"
  | "threadPinReorder"
  | "threadTitleRegeneration";

/**
 * Version skew guard: never send a thread list command to a server that
 * predates it (capabilities decode as false on older servers).
 */
export function environmentSupportsThreadCapability(
  environmentId: EnvironmentThreadShell["environmentId"],
  capability: ThreadCapability,
): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities[
      capability
    ] === true
  );
}
