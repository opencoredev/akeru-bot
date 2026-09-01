import type { DesktopUpdateChannel } from "@t3tools/contracts";

export function resolveDefaultDesktopUpdateChannel(_appVersion: string): DesktopUpdateChannel {
  return "latest";
}
