import { Match } from "effect";
import { ChevronsLeftRightEllipsisIcon, PlusIcon, TerminalIcon } from "lucide-react";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { ScrollArea } from "../ui/scroll-area";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import { AnimatedHeight } from "../AnimatedHeight";
import { resolveServerSelfUpdateCapability } from "~/versionSkew";
import { ServerUpdateAction, ServerUpdateProgress } from "../ServerUpdateAction";
import { RemoteHealthSection } from "./RemoteHealthSection";
import { AuthorizedClientsHeaderAction } from "./ConnectionAuthorizedClients";
import { SavedBackendListRow, EmptyRemoteEnvironments } from "./DesktopBackendRows";
import { useDesktopBackendSettings } from "./useDesktopBackendSettings";
import { connectionSettingsViews } from "./ConnectionSettingsViews";

export function ConnectionsSettings() {
  const settings = useDesktopBackendSettings();

  const {
    t,
    desktopBridge,
    primaryEnvironment,
    primaryEnvironmentId,
    savedEnvironments,
    isRevokingOtherDesktopClients,
    addBackendDialogOpen,
    setAddBackendDialogOpen,
    savedBackendMode,
    setSavedBackendError,
    removingSavedEnvironmentId,
    isUpdatingDesktopServerExposure,
    isDesktopServerExposureDialogOpen,
    setIsDesktopServerExposureDialogOpen,
    isUpdatingTailscaleServe,
    isUpdatingWslBackend,
    pendingWslChange,
    setPendingWslChange,
    isWslConfirmDialogOpen,
    pendingTailscaleServeEndpoint,
    setPendingTailscaleServeEndpoint,
    disableTailscaleServeDialogOpen,
    setDisableTailscaleServeDialogOpen,
    tailscaleServePortInput,
    setTailscaleServePortInput,
    pendingDesktopServerExposureMode,
    setPendingDesktopServerExposureMode,
    primaryServerConfig,
    primaryVersionMismatch,
    primaryServerUpdateState,
    canManageLocalBackend,
    desktopClientSessions,
    isTailscaleServePortValid,
    pendingTailscaleServeBaseUrl,
    handleConfirmDesktopServerExposureChange,
    handleConfirmTailscaleServeSetup,
    handleConfirmTailscaleServeDisable,
    handleRevokeOtherDesktopClients,
    handleConnectSavedBackend,
    handleRemoveSavedBackend,
    isLocalBackendRemotelyReachable,
    handleConfirmEnableWsl,
    handleConfirmWslChange,
  } = settings;

  const {
    renderConnectionModeCard,
    renderRemoteModeBody,
    renderSshFields,
    renderEndpointRows,
    renderWslRow,
    renderTailscaleRow,
    renderAuthorizedClients,
    renderNetworkAccessRow,
    renderDisabledNetworkAccessRow,
  } = connectionSettingsViews(settings);

  return (
    <SettingsPageContainer>
      {canManageLocalBackend ? (
        <>
          <SettingsSection title="This environment">
            {primaryVersionMismatch || primaryServerUpdateState.status !== "idle" ? (
              <SettingsRow
                title={Match.value(primaryServerUpdateState).pipe(
                  Match.when({ status: "failed" }, () => "Update failed"),
                  Match.when({ status: "running" }, () => "Updating server"),
                  Match.orElse(() => "Server update available"),
                )}
                description={
                  primaryServerUpdateState.status !== "idle" ? (
                    <ServerUpdateProgress state={primaryServerUpdateState} />
                  ) : primaryVersionMismatch ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button type="button" className="w-fit cursor-help rounded-sm text-left">
                            Update to match this client.
                          </button>
                        }
                      />
                      <TooltipPopup side="top">
                        {primaryVersionMismatch.serverVersion} <span aria-hidden="true">→</span>{" "}
                        {primaryVersionMismatch.clientVersion}
                      </TooltipPopup>
                    </Tooltip>
                  ) : null
                }
                control={
                  primaryVersionMismatch &&
                  primaryEnvironmentId !== null &&
                  primaryServerUpdateState.status !== "running" ? (
                    <ServerUpdateAction
                      environmentId={primaryEnvironmentId}
                      serverLabel={primaryEnvironment?.label ?? "this server"}
                      selfUpdate={resolveServerSelfUpdateCapability(primaryServerConfig)}
                      targetVersion={primaryVersionMismatch.clientVersion}
                      label={primaryServerUpdateState.status === "failed" ? "Retry" : "Update"}
                    />
                  ) : undefined
                }
              />
            ) : null}
            {desktopBridge ? (
              <>
                {renderNetworkAccessRow()}
                {renderEndpointRows("endpoint-rail")}
                {renderTailscaleRow()}
                {renderWslRow()}
              </>
            ) : (
              <>{renderDisabledNetworkAccessRow()}</>
            )}
          </SettingsSection>

          {primaryEnvironmentId !== null ? (
            <RemoteHealthSection environmentId={primaryEnvironmentId} />
          ) : null}

          {isLocalBackendRemotelyReachable ? (
            <SettingsSection
              title="Authorized clients"
              headerAction={
                <AuthorizedClientsHeaderAction
                  clientSessions={desktopClientSessions}
                  isRevokingOtherClients={isRevokingOtherDesktopClients}
                  onRevokeOtherClients={handleRevokeOtherDesktopClients}
                />
              }
            >
              <ScrollArea
                scrollFade
                className="max-h-90"
                data-testid="authorized-clients-scroll-area"
              >
                {renderAuthorizedClients("current")}
              </ScrollArea>
            </SettingsSection>
          ) : null}
          <AlertDialog
            open={isDesktopServerExposureDialogOpen}
            onOpenChange={(open) => {
              if (isUpdatingDesktopServerExposure) return;
              setIsDesktopServerExposureDialogOpen(open);
            }}
            onOpenChangeComplete={(open) => {
              if (!open) setPendingDesktopServerExposureMode(null);
            }}
          >
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {pendingDesktopServerExposureMode === "network-accessible"
                    ? "Enable network access?"
                    : "Disable network access?"}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {pendingDesktopServerExposureMode === "network-accessible"
                    ? "Akeru Bot will restart to expose this environment over the network."
                    : "Akeru Bot will restart and limit this environment back to this machine."}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose
                  disabled={isUpdatingDesktopServerExposure}
                  render={<Button variant="outline" disabled={isUpdatingDesktopServerExposure} />}
                >
                  Cancel
                </AlertDialogClose>
                <Button
                  variant={
                    pendingDesktopServerExposureMode === "local-only" ? "destructive" : "default"
                  }
                  onClick={handleConfirmDesktopServerExposureChange}
                  disabled={
                    pendingDesktopServerExposureMode === null || isUpdatingDesktopServerExposure
                  }
                >
                  {isUpdatingDesktopServerExposure ? (
                    <>
                      <Spinner className="size-3.5" />
                      Restarting…
                    </>
                  ) : pendingDesktopServerExposureMode === "network-accessible" ? (
                    "Restart and enable"
                  ) : (
                    "Restart and disable"
                  )}
                </Button>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
          <AlertDialog
            open={isWslConfirmDialogOpen}
            onOpenChange={(open) => {
              if (isUpdatingWslBackend) return;

              if (!open) setPendingWslChange(null);
            }}
          >
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {pendingWslChange?.kind === "disable"
                    ? pendingWslChange.wasWslOnly
                      ? "Turn off WSL and switch back to Windows?"
                      : "Disable WSL backend?"
                    : pendingWslChange?.kind === "distro"
                      ? "Switch WSL distro?"
                      : pendingWslChange?.kind === "enable"
                        ? "Start the WSL backend"
                        : pendingWslChange?.nextValue
                          ? "Run only the WSL backend?"
                          : "Re-enable the Windows backend?"}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {pendingWslChange?.kind === "disable"
                    ? pendingWslChange.wasWslOnly
                      ? "Akeru Bot will restart on the Windows backend. Chats and projects opened against WSL stay safe inside the distro and become available again when you re-enable WSL."
                      : "The WSL backend will stop. Chats and projects opened against WSL stay safe inside the distro, but they'll be unavailable in Akeru Bot until you re-enable WSL."
                    : pendingWslChange?.kind === "distro"
                      ? "Akeru Bot will restart the WSL backend on the new distro. Sessions still running on the current distro will be interrupted."
                      : pendingWslChange?.kind === "enable"
                        ? "Run the WSL backend alongside the Windows one, or stop the Windows backend and use only WSL? You can change this later from Settings."
                        : pendingWslChange?.nextValue
                          ? "Akeru Bot will restart and start only the WSL backend. Your Windows-side projects won't be accessible until you turn this off again."
                          : "Akeru Bot will restart and bring the Windows backend back up alongside WSL."}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose
                  disabled={isUpdatingWslBackend}
                  render={<Button variant="outline" disabled={isUpdatingWslBackend} />}
                >
                  Cancel
                </AlertDialogClose>
                {pendingWslChange?.kind === "enable" ? (
                  <>
                    <Button
                      variant="outline"
                      onClick={() => handleConfirmEnableWsl("wsl-only")}
                      disabled={isUpdatingWslBackend}
                    >
                      {isUpdatingWslBackend ? (
                        <>
                          <Spinner className="size-3.5" />
                          Applying…
                        </>
                      ) : (
                        "Use only WSL"
                      )}
                    </Button>
                    <Button
                      variant="default"
                      onClick={() => handleConfirmEnableWsl("both")}
                      disabled={isUpdatingWslBackend}
                    >
                      {isUpdatingWslBackend ? (
                        <>
                          <Spinner className="size-3.5" />
                          Applying…
                        </>
                      ) : (
                        "Run both backends"
                      )}
                    </Button>
                  </>
                ) : (
                  <Button
                    variant={
                      pendingWslChange?.kind === "disable" ||
                      (pendingWslChange?.kind === "wsl-only" && pendingWslChange.nextValue)
                        ? "destructive"
                        : "default"
                    }
                    onClick={handleConfirmWslChange}
                    disabled={isUpdatingWslBackend}
                  >
                    {isUpdatingWslBackend ? (
                      <>
                        <Spinner className="size-3.5" />
                        Applying…
                      </>
                    ) : pendingWslChange?.kind === "disable" ? (
                      pendingWslChange.wasWslOnly ? (
                        "Switch to Windows"
                      ) : (
                        "Disable WSL"
                      )
                    ) : pendingWslChange?.kind === "distro" ? (
                      "Switch distro"
                    ) : pendingWslChange?.nextValue ? (
                      "Restart and enable"
                    ) : (
                      "Restart and disable"
                    )}
                  </Button>
                )}
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
          <AlertDialog
            open={disableTailscaleServeDialogOpen}
            onOpenChange={(open) => {
              if (isUpdatingTailscaleServe) return;
              setDisableTailscaleServeDialogOpen(open);
            }}
          >
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>Disable Tailscale HTTPS?</AlertDialogTitle>
                <AlertDialogDescription>
                  Akeru Bot will restart the local backend without Tailscale Serve.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose
                  disabled={isUpdatingTailscaleServe}
                  render={<Button variant="outline" disabled={isUpdatingTailscaleServe} />}
                >
                  Cancel
                </AlertDialogClose>
                <Button
                  variant="destructive"
                  onClick={() => void handleConfirmTailscaleServeDisable()}
                  disabled={isUpdatingTailscaleServe}
                >
                  {isUpdatingTailscaleServe ? (
                    <>
                      <Spinner className="size-3.5" />
                      Restarting…
                    </>
                  ) : (
                    "Restart and disable"
                  )}
                </Button>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
          <Dialog
            open={pendingTailscaleServeEndpoint !== null}
            onOpenChange={(open) => {
              if (isUpdatingTailscaleServe) return;

              if (!open) setPendingTailscaleServeEndpoint(null);
            }}
          >
            <DialogPopup className="max-w-md">
              <DialogHeader>
                <DialogTitle>Set up Tailscale HTTPS?</DialogTitle>
                <DialogDescription>
                  Akeru Bot will restart the local backend with Tailscale Serve enabled and ask
                  Tailscale to proxy HTTPS traffic to this backend.
                </DialogDescription>
              </DialogHeader>
              <DialogPanel className="space-y-4">
                <label className="block">
                  <span className="text-sm font-medium text-foreground">HTTPS port</span>
                  <Input
                    className="mt-2"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={65_535}
                    step={1}
                    value={tailscaleServePortInput}
                    onChange={(event) => setTailscaleServePortInput(event.target.value)}
                    disabled={isUpdatingTailscaleServe}
                  />
                </label>
                {!isTailscaleServePortValid ? (
                  <p className="mt-2 text-xs text-destructive">Enter a port from 1 to 65535.</p>
                ) : null}
                <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-2">
                  <p className="text-xs font-medium text-muted-foreground">HTTPS endpoint</p>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <p className="mt-1 truncate text-sm text-foreground">
                          {pendingTailscaleServeBaseUrl ?? "Pending MagicDNS endpoint"}
                        </p>
                      }
                    />
                    {pendingTailscaleServeBaseUrl ? (
                      <TooltipPopup side="top" className="max-w-80">
                        {pendingTailscaleServeBaseUrl}
                      </TooltipPopup>
                    ) : null}
                  </Tooltip>
                </div>
              </DialogPanel>
              <DialogFooter>
                <DialogClose
                  disabled={isUpdatingTailscaleServe}
                  render={<Button variant="outline" disabled={isUpdatingTailscaleServe} />}
                >
                  Cancel
                </DialogClose>
                <Button
                  onClick={() => void handleConfirmTailscaleServeSetup()}
                  disabled={isUpdatingTailscaleServe || !isTailscaleServePortValid}
                >
                  {isUpdatingTailscaleServe ? (
                    <>
                      <Spinner className="size-3.5" />
                      Restarting…
                    </>
                  ) : (
                    "Enable"
                  )}
                </Button>
              </DialogFooter>
            </DialogPopup>
          </Dialog>
        </>
      ) : (
        <SettingsSection title="This environment">
          <SettingsRow
            title="Pairing and device access"
            description="This device can use your bots, but it can't create pairing links or sign other devices out. Do that from Akeru Bot on the computer that runs this server."
          />
        </SettingsSection>
      )}

      <SettingsSection
        {...searchableSetting("remote-environments", t)}
        headerAction={
          <Dialog
            open={addBackendDialogOpen}
            onOpenChange={(open) => {
              setAddBackendDialogOpen(open);

              if (!open) {
                setSavedBackendError(null);
              }
            }}
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <DialogTrigger
                    render={
                      <Button
                        size="xs"
                        variant="outline"
                        presentation="compact-gap"
                        aria-label="Add environment"
                      >
                        <PlusIcon className="size-3" />
                        <span>Add environment</span>
                      </Button>
                    }
                  />
                }
              />
              <TooltipPopup side="top">Add environment</TooltipPopup>
            </Tooltip>
            <DialogPopup className="max-h-[80dvh] sm:max-w-3xl">
              <DialogHeader>
                <DialogTitle>Add environment</DialogTitle>
                <DialogDescription>
                  Connect this client to another server. Its bots, chats, and projects stay on that
                  server.
                </DialogDescription>
              </DialogHeader>
              <DialogPanel>
                <div className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    {renderConnectionModeCard({
                      mode: "remote",
                      title: "Remote link",
                      description: "Enter a backend host and pairing code.",
                      icon: <ChevronsLeftRightEllipsisIcon aria-hidden className="size-4" />,
                    })}
                    {desktopBridge
                      ? renderConnectionModeCard({
                          mode: "ssh",
                          title: "SSH",
                          description: "Use local SSH config, agent, and tunnels for the backend.",
                          icon: <TerminalIcon aria-hidden className="size-4" />,
                        })
                      : null}
                  </div>
                  <AnimatedHeight>
                    {savedBackendMode === "ssh" ? renderSshFields() : renderRemoteModeBody()}
                  </AnimatedHeight>
                </div>
              </DialogPanel>
            </DialogPopup>
          </Dialog>
        }
      >
        {savedEnvironments.map((environment) => (
          <SavedBackendListRow
            key={environment.environmentId}
            environment={environment}
            removingEnvironmentId={removingSavedEnvironmentId}
            onConnect={handleConnectSavedBackend}
            onRemove={handleRemoveSavedBackend}
          />
        ))}
        {savedEnvironments.length === 0 ? <EmptyRemoteEnvironments /> : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export { useDesktopBackendSettings } from "./useDesktopBackendSettings";

export { connectionSettingsViews } from "./ConnectionSettingsViews";
