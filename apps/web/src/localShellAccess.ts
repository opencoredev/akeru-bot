/**
 * Whether this client runs on the environment's own machine, so shell actions
 * such as "Open in editor" or "Reveal in file manager" land where the user can
 * see them. Remote clients hide those actions.
 */
import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { isLoopbackHostname } from "~/environments/primary/target";
import { useEnvironmentPresentation } from "~/state/presentation";

export interface LocalShellAccess {
  readonly isLocal: boolean;
  readonly isResolved: boolean;
}

const UNRESOLVED: LocalShellAccess = { isLocal: false, isResolved: false };

function parseHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function isLocalShellTarget(input: {
  readonly target: ConnectionTarget | null;
  /** True when running inside the desktop app's renderer. */
  readonly isDesktopRenderer: boolean;
}): boolean {
  const { target } = input;
  // No catalog entry: keep exec behavior rather than guessing.
  if (target === null) return true;
  if (target._tag === "PrimaryConnectionTarget") {
    // The desktop app manages its own primary backend, so it is always on
    // this machine even when its URL is not loopback (wsl-only mode binds
    // the WSL2 NAT address). In a browser, a loopback primary means the
    // browser runs on the serving machine; a tailnet/LAN URL means remote.
    if (input.isDesktopRenderer) return true;
    const hostname = parseHostname(target.httpBaseUrl);
    return hostname !== null && isLoopbackHostname(hostname);
  }
  return isDesktopLocalConnectionTarget(target);
}

export function useLocalShellAccess(environmentId: EnvironmentId | null): LocalShellAccess {
  const { presentation } = useEnvironmentPresentation(environmentId);

  return useMemo(() => {
    if (presentation === null) return UNRESOLVED;
    return {
      isLocal: isLocalShellTarget({
        target: presentation.entry.target,
        isDesktopRenderer: window.desktopBridge !== undefined,
      }),
      isResolved: true,
    };
  }, [presentation]);
}
