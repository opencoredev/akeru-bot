/**
 * Drivers that run on Akeru's controller, which is the only runtime that can
 * advertise SendToAgent and enforce a delegated child's access grant. Every
 * other driver runs on the legacy adapter bridge and can neither hand off work
 * nor receive it.
 */
export const DELEGATION_DRIVER_KINDS = [
  "codex",
  "claudeAgent",
  "grok",
  "kimi",
  "opencodeGo",
] as const;

const delegationDriverKinds: ReadonlySet<string> = new Set(DELEGATION_DRIVER_KINDS);

/** True when bots on this driver can delegate work and receive delegated work. */
export function driverSupportsDelegation(driverKind: string): boolean {
  return delegationDriverKinds.has(driverKind);
}
