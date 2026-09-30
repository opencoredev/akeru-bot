import type { DesktopUpdateChannel } from "@akeru/contracts";

export function resolveDefaultDesktopUpdateChannel(_appVersion: string): DesktopUpdateChannel {
  return "latest";
}
