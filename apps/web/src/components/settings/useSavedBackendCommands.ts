import { Predicate } from "effect";
import { useCallback } from "react";
import { type DesktopSshEnvironmentTarget, type EnvironmentId } from "@akeru/contracts";
import {
  type AtomCommand,
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@akeru/client-runtime/state/runtime";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { environmentCatalog } from "~/connection/catalog";
import {
  connectPairing as connectPairingAtom,
  connectSshEnvironment as connectSshEnvironmentAtom,
} from "~/connection/onboarding";
import { type EnvironmentPresentation } from "~/state/environments";
import {
  parseManualDesktopSshTarget,
  parseRemotePairingFields,
  formatDesktopSshConnectionError,
} from "./connectionPresentation.logic";

/** The runner `useAtomCommand` returns for a given command. */
type AtomCommandRunner<C> =
  C extends AtomCommand<infer W, infer A, infer E>
    ? (value: W) => Promise<AtomCommandResult<A, E>>
    : never;

/** Add, connect, remove, and SSH-connect commands for saved remote environments. */
export function useSavedBackendCommands({
  connectPairing,
  connectSshEnvironment,
  removeEnvironment,
  retryEnvironment,
  savedBackendMode,
  savedBackendHost,
  savedBackendPairingCode,
  savedBackendSshHost,
  savedBackendSshUsername,
  savedBackendSshPort,
  savedDesktopSshEnvironmentsByAlias,
  setIsAddingSavedBackend,
  setSavedBackendError,
  setSavedBackendHost,
  setSavedBackendPairingCode,
  setSavedBackendSshHost,
  setSavedBackendSshUsername,
  setSavedBackendSshPort,
  setAddBackendDialogOpen,
  setRemovingSavedEnvironmentId,
  setConnectingSshHostAlias,
  setSshConnectionError,
}: {
  connectPairing: AtomCommandRunner<typeof connectPairingAtom>;
  connectSshEnvironment: AtomCommandRunner<typeof connectSshEnvironmentAtom>;
  removeEnvironment: AtomCommandRunner<typeof environmentCatalog.remove>;
  retryEnvironment: AtomCommandRunner<typeof environmentCatalog.retryNow>;
  savedBackendMode: "remote" | "ssh";
  savedBackendHost: string;
  savedBackendPairingCode: string;
  savedBackendSshHost: string;
  savedBackendSshUsername: string;
  savedBackendSshPort: string;
  savedDesktopSshEnvironmentsByAlias: Record<string, EnvironmentPresentation>;
  setIsAddingSavedBackend: (value: boolean) => void;
  setSavedBackendError: (value: string | null) => void;
  setSavedBackendHost: (value: string) => void;
  setSavedBackendPairingCode: (value: string) => void;
  setSavedBackendSshHost: (value: string) => void;
  setSavedBackendSshUsername: (value: string) => void;
  setSavedBackendSshPort: (value: string) => void;
  setAddBackendDialogOpen: (value: boolean) => void;
  setRemovingSavedEnvironmentId: (environmentId: EnvironmentId | null) => void;
  setConnectingSshHostAlias: (value: string | null) => void;
  setSshConnectionError: (value: string | null) => void;
}) {
  const handleAddSavedBackend = useCallback(async () => {
    if (savedBackendMode === "ssh") {
      setIsAddingSavedBackend(true);
      setSavedBackendError(null);
      let target: DesktopSshEnvironmentTarget;

      try {
        target = parseManualDesktopSshTarget({
          host: savedBackendSshHost,
          username: savedBackendSshUsername,
          port: savedBackendSshPort,
        });
      } catch (error) {
        setSavedBackendError(formatDesktopSshConnectionError(error));
        setIsAddingSavedBackend(false);

        return;
      }

      const result = await connectSshEnvironment({ target, label: "" });

      if (Predicate.isTagged(result, "Failure")) {
        if (!isAtomCommandInterrupted(result)) {
          setSavedBackendError(formatDesktopSshConnectionError(squashAtomCommandFailure(result)));
        }

        setIsAddingSavedBackend(false);

        return;
      }

      setSavedBackendHost("");
      setSavedBackendPairingCode("");
      setSavedBackendSshHost("");
      setSavedBackendSshUsername("");
      setSavedBackendSshPort("");
      setAddBackendDialogOpen(false);
      toastManager.add({
        type: "success",
        title: "Environment connected",
        description: `${target.alias} is ready over an SSH-managed tunnel.`,
      });
      setIsAddingSavedBackend(false);

      return;
    }

    setIsAddingSavedBackend(true);
    setSavedBackendError(null);
    let remotePairingInput: ReturnType<typeof parseRemotePairingFields>;

    try {
      remotePairingInput = parseRemotePairingFields({
        host: savedBackendHost,
        pairingCode: savedBackendPairingCode,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to add backend.";
      setSavedBackendError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not add backend",
          description: message,
        }),
      );
      setIsAddingSavedBackend(false);

      return;
    }

    const result = await connectPairing(remotePairingInput);

    if (Predicate.isTagged(result, "Failure")) {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        const message = error instanceof Error ? error.message : "Failed to add backend.";
        setSavedBackendError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not add backend",
            description: message,
          }),
        );
      }

      setIsAddingSavedBackend(false);

      return;
    }

    setSavedBackendHost("");
    setSavedBackendPairingCode("");
    setSavedBackendSshHost("");
    setSavedBackendSshUsername("");
    setSavedBackendSshPort("");
    setAddBackendDialogOpen(false);
    toastManager.add({
      type: "success",
      title: "Backend added",
      description: "The environment is saved and will reconnect on app startup.",
    });
    setIsAddingSavedBackend(false);
  }, [
    connectPairing,
    connectSshEnvironment,
    savedBackendHost,
    savedBackendMode,
    savedBackendPairingCode,
    savedBackendSshHost,
    savedBackendSshPort,
    savedBackendSshUsername,
  ]);

  const handleConnectSavedBackend = useCallback(
    async (environmentId: EnvironmentId) => {
      setSavedBackendError(null);
      const result = await retryEnvironment(environmentId);

      if (Predicate.isTagged(result, "Failure") && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        const message = error instanceof Error ? error.message : "Failed to connect backend.";
        setSavedBackendError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not connect backend",
            description: message,
          }),
        );
      }
    },
    [retryEnvironment],
  );

  const handleRemoveSavedBackend = useCallback(
    async (environmentId: EnvironmentId) => {
      setRemovingSavedEnvironmentId(environmentId);
      setSavedBackendError(null);
      const result = await removeEnvironment(environmentId);
      setRemovingSavedEnvironmentId(null);

      if (Predicate.isTagged(result, "Failure") && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        const message = error instanceof Error ? error.message : "Failed to remove backend.";
        setSavedBackendError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not remove backend",
            description: message,
          }),
        );
      }
    },
    [removeEnvironment],
  );

  const handleConnectSshHost = useCallback(
    async (target: DesktopSshEnvironmentTarget, label?: string) => {
      setConnectingSshHostAlias(target.alias);

      if (savedBackendMode === "ssh") {
        setSavedBackendError(null);
      } else {
        setSshConnectionError(null);
      }

      const result = await connectSshEnvironment({
        target,
        ...(label === undefined ? {} : { label }),
      });

      setConnectingSshHostAlias(null);

      if (Predicate.isTagged(result, "Success")) {
        setSavedBackendSshHost("");
        setSavedBackendSshUsername("");
        setSavedBackendSshPort("");
        setAddBackendDialogOpen(false);
        toastManager.add({
          type: "success",
          title: savedDesktopSshEnvironmentsByAlias[target.alias]
            ? "Environment reconnected"
            : "Environment connected",
          description: `${label?.trim() || target.alias} is ready over an SSH-managed tunnel.`,
        });

        return;
      }

      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        const message = formatDesktopSshConnectionError(error);

        if (savedBackendMode === "ssh") {
          setSavedBackendError(message);
        } else {
          setSshConnectionError(message);
        }
      }
    },
    [connectSshEnvironment, savedBackendMode, savedDesktopSshEnvironmentsByAlias],
  );

  return {
    handleAddSavedBackend,
    handleConnectSavedBackend,
    handleRemoveSavedBackend,
    handleConnectSshHost,
  };
}
