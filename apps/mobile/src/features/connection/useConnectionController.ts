import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { environmentCatalog } from "../../connection/catalog";
import {
  connectPairingUrl as connectPairingUrlAtom,
  updateBearerConnection,
} from "../../connection/onboarding";
import { useEnvironments } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { projectWorkspaceEnvironment, type WorkspaceEnvironment } from "../../state/workspaceModel";

export function useConnectionController() {
  const { environments } = useEnvironments();
  const connectPairingUrlMutation = useAtomCommand(connectPairingUrlAtom, {
    reportFailure: false,
  });
  const updateBearer = useAtomCommand(updateBearerConnection, { reportFailure: false });
  const removeEnvironmentMutation = useAtomCommand(environmentCatalog.remove, "environment remove");
  const retryEnvironmentMutation = useAtomCommand(environmentCatalog.retryNow, "environment retry");

  const connectedEnvironments = useMemo<ReadonlyArray<WorkspaceEnvironment>>(
    () => environments.map(projectWorkspaceEnvironment),
    [environments],
  );
  const connectPairingUrl = useCallback(
    (pairingUrl: string) => connectPairingUrlMutation(pairingUrl),
    [connectPairingUrlMutation],
  );
  const removeEnvironment = useCallback(
    (environmentId: EnvironmentId) => removeEnvironmentMutation(environmentId),
    [removeEnvironmentMutation],
  );
  const retryEnvironment = useCallback(
    (environmentId: EnvironmentId) => retryEnvironmentMutation(environmentId),
    [retryEnvironmentMutation],
  );
  const updateEnvironment = useCallback(
    (
      environmentId: EnvironmentId,
      updates: { readonly label: string; readonly displayUrl: string },
    ) =>
      updateBearer({
        environmentId,
        label: updates.label,
        httpBaseUrl: updates.displayUrl,
      }),
    [updateBearer],
  );

  return {
    connectedEnvironments,
    connectPairingUrl,
    removeEnvironment,
    retryEnvironment,
    updateEnvironment,
  };
}
