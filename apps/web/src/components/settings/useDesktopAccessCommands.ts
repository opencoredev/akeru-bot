import { useCallback } from "react";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  revokeOtherServerClientSessions,
  revokeServerClientSession,
  revokeServerPairingLink,
  type ServerClientSessionRecord,
} from "~/environments/primary";

/** Revocation commands for the local backend's pairing links and client sessions. */
export function useDesktopAccessCommands({
  setRevokingDesktopPairingLinkId,
  setRevokingDesktopClientSessionId,
  setIsRevokingOtherDesktopClients,
  setDesktopAccessManagementMutationError,
}: {
  setRevokingDesktopPairingLinkId: (value: string | null) => void;
  setRevokingDesktopClientSessionId: (
    sessionId: ServerClientSessionRecord["sessionId"] | null,
  ) => void;
  setIsRevokingOtherDesktopClients: (value: boolean) => void;
  setDesktopAccessManagementMutationError: (value: string | null) => void;
}) {
  const handleRevokeDesktopPairingLink = useCallback(async (id: string) => {
    setRevokingDesktopPairingLinkId(id);
    setDesktopAccessManagementMutationError(null);

    try {
      await revokeServerPairingLink(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to revoke pairing link.";
      setDesktopAccessManagementMutationError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not revoke pairing link",
          description: message,
        }),
      );
    } finally {
      setRevokingDesktopPairingLinkId(null);
    }
  }, []);

  const handleRevokeDesktopClientSession = useCallback(
    async (sessionId: ServerClientSessionRecord["sessionId"]) => {
      setRevokingDesktopClientSessionId(sessionId);
      setDesktopAccessManagementMutationError(null);

      try {
        await revokeServerClientSession(sessionId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to revoke client access.";
        setDesktopAccessManagementMutationError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not revoke client access",
            description: message,
          }),
        );
      } finally {
        setRevokingDesktopClientSessionId(null);
      }
    },
    [],
  );

  const handleRevokeOtherDesktopClients = useCallback(async () => {
    setIsRevokingOtherDesktopClients(true);
    setDesktopAccessManagementMutationError(null);

    try {
      const revokedCount = await revokeOtherServerClientSessions();
      toastManager.add({
        type: "success",
        title: revokedCount === 1 ? "Revoked 1 other client" : `Revoked ${revokedCount} clients`,
        description: "Other paired clients will need a new pairing link before reconnecting.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to revoke other clients.";
      setDesktopAccessManagementMutationError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not revoke other clients",
          description: message,
        }),
      );
    } finally {
      setIsRevokingOtherDesktopClients(false);
    }
  }, []);

  return {
    handleRevokeDesktopPairingLink,
    handleRevokeDesktopClientSession,
    handleRevokeOtherDesktopClients,
  };
}
