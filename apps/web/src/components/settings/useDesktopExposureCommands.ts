import { useCallback } from "react";
import { type AdvertisedEndpoint, type DesktopServerExposureState } from "@akeru/contracts";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { refreshDesktopNetworkAccessState } from "~/state/desktopNetworkAccess";

export const DEFAULT_TAILSCALE_SERVE_PORT = 443;

/** Network exposure and Tailscale HTTPS commands for the local desktop backend. */
export function useDesktopExposureCommands({
  desktopBridge,
  desktopServerExposureState,
  pendingDesktopServerExposureMode,
  isTailscaleServePortValid,
  parsedTailscaleServePort,
  setIsUpdatingDesktopServerExposure,
  setDesktopServerExposureMutationError,
  setIsDesktopServerExposureDialogOpen,
  setIsUpdatingTailscaleServe,
  setPendingTailscaleServeEndpoint,
  setTailscaleServePortInput,
  setDisableTailscaleServeDialogOpen,
}: {
  desktopBridge: Window["desktopBridge"];
  desktopServerExposureState: DesktopServerExposureState | null;
  pendingDesktopServerExposureMode: DesktopServerExposureState["mode"] | null;
  isTailscaleServePortValid: boolean;
  parsedTailscaleServePort: number;
  setIsUpdatingDesktopServerExposure: (value: boolean) => void;
  setDesktopServerExposureMutationError: (value: string | null) => void;
  setIsDesktopServerExposureDialogOpen: (value: boolean) => void;
  setIsUpdatingTailscaleServe: (value: boolean) => void;
  setPendingTailscaleServeEndpoint: (endpoint: AdvertisedEndpoint | null) => void;
  setTailscaleServePortInput: (value: string) => void;
  setDisableTailscaleServeDialogOpen: (value: boolean) => void;
}) {
  const handleDesktopServerExposureChange = useCallback(
    async (checked: boolean) => {
      if (!desktopBridge) return;
      setIsUpdatingDesktopServerExposure(true);
      setDesktopServerExposureMutationError(null);

      try {
        await desktopBridge.setServerExposureMode(checked ? "network-accessible" : "local-only");
        refreshDesktopNetworkAccessState();
        setIsDesktopServerExposureDialogOpen(false);
        setIsUpdatingDesktopServerExposure(false);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to update network exposure.";

        setIsDesktopServerExposureDialogOpen(false);
        setDesktopServerExposureMutationError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not update network access",
            description: message,
          }),
        );
        setIsUpdatingDesktopServerExposure(false);
      }
    },
    [desktopBridge],
  );

  const handleConfirmDesktopServerExposureChange = useCallback(() => {
    if (pendingDesktopServerExposureMode === null) return;
    const checked = pendingDesktopServerExposureMode === "network-accessible";
    void handleDesktopServerExposureChange(checked);
  }, [handleDesktopServerExposureChange, pendingDesktopServerExposureMode]);

  const handleConfirmTailscaleServeSetup = useCallback(async () => {
    if (!desktopBridge) return;

    if (!isTailscaleServePortValid) return;
    setIsUpdatingTailscaleServe(true);
    setDesktopServerExposureMutationError(null);

    try {
      await desktopBridge.setTailscaleServeEnabled({
        enabled: true,
        port: parsedTailscaleServePort,
      });
      refreshDesktopNetworkAccessState();
      setPendingTailscaleServeEndpoint(null);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to configure Tailscale HTTPS.";

      setDesktopServerExposureMutationError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not set up Tailscale HTTPS",
          description: message,
        }),
      );
    } finally {
      setIsUpdatingTailscaleServe(false);
    }
  }, [desktopBridge, isTailscaleServePortValid, parsedTailscaleServePort]);

  const handleStartTailscaleServeSetup = useCallback(
    (endpoint: AdvertisedEndpoint) => {
      setTailscaleServePortInput(
        String(desktopServerExposureState?.tailscaleServePort ?? DEFAULT_TAILSCALE_SERVE_PORT),
      );
      setPendingTailscaleServeEndpoint(endpoint);
    },
    [desktopServerExposureState?.tailscaleServePort],
  );

  const handleConfirmTailscaleServeDisable = useCallback(async () => {
    if (!desktopBridge) return;
    setIsUpdatingTailscaleServe(true);
    setDesktopServerExposureMutationError(null);

    try {
      await desktopBridge.setTailscaleServeEnabled({
        enabled: false,
        port: desktopServerExposureState?.tailscaleServePort ?? DEFAULT_TAILSCALE_SERVE_PORT,
      });
      refreshDesktopNetworkAccessState();
      setDisableTailscaleServeDialogOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to disable Tailscale HTTPS.";
      setDesktopServerExposureMutationError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not disable Tailscale HTTPS",
          description: message,
        }),
      );
    } finally {
      setIsUpdatingTailscaleServe(false);
    }
  }, [desktopBridge, desktopServerExposureState?.tailscaleServePort]);

  const handleStartTailscaleServeDisable = useCallback((_endpoint: AdvertisedEndpoint) => {
    setDisableTailscaleServeDialogOpen(true);
  }, []);

  return {
    handleConfirmDesktopServerExposureChange,
    handleConfirmTailscaleServeSetup,
    handleStartTailscaleServeSetup,
    handleConfirmTailscaleServeDisable,
    handleStartTailscaleServeDisable,
  };
}
