import { ChevronsLeftRightEllipsisIcon, RefreshCwIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { memo, useCallback } from "react";
import { type DesktopDiscoveredSshHost, type EnvironmentId } from "@akeru/contracts";
import { translateConnectionStatus } from "@akeru/client-runtime/i18n";
import { useI18n } from "../../i18n";
import * as Option from "effect/Option";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import {
  resolveServerConfigVersionMismatch,
  resolveServerSelfUpdateCapability,
} from "~/versionSkew";
import { type EnvironmentPresentation } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { ServerUpdateAction, ServerUpdateProgress } from "../ServerUpdateAction";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";
import { formatDesktopSshTarget } from "./connectionPresentation.logic";

type SavedBackendListRowProps = {
  environment: EnvironmentPresentation;
  removingEnvironmentId: EnvironmentId | null;
  onConnect: (environmentId: EnvironmentId) => void;
  onRemove: (environmentId: EnvironmentId) => void;
};

export function SavedBackendListRow({
  environment,
  removingEnvironmentId,
  onConnect,
  onRemove,
}: SavedBackendListRowProps) {
  const { t } = useI18n();
  const environmentId = environment.environmentId;
  const connectionState = environment.connection.phase;
  const isConnected = connectionState === "connected";
  const isConnecting = connectionState === "connecting" || connectionState === "reconnecting";
  const stateDotClassName =
    connectionState === "connected"
      ? "bg-success"
      : connectionState === "connecting" || connectionState === "reconnecting"
        ? "bg-warning"
        : connectionState === "error"
          ? "bg-destructive"
          : "bg-muted-foreground/40";
  const statusTooltip = translateConnectionStatus(t, environment.connection);
  const errorTraceId = environment.connection.traceId;
  const { copyToClipboard: copyTraceIdToClipboard } = useCopyToClipboard<{ traceId: string }>({
    target: "trace ID",
    onCopy: ({ traceId }) => {
      toastManager.add({
        type: "success",
        title: "Trace ID copied",
        description: traceId,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy trace ID",
          description: error.message,
        }),
      );
    },
  });
  const copyTraceId = useCallback(
    (traceId: string) => {
      copyTraceIdToClipboard(traceId, { traceId });
    },
    [copyTraceIdToClipboard],
  );
  const versionMismatch = resolveServerConfigVersionMismatch(environment.serverConfig);
  const serverUpdateState = useAtomValue(serverEnvironment.updateStateAtom(environmentId));
  const resumingServerUpdate =
    serverUpdateState.status === "running" && serverUpdateState.stage === "resuming";
  const sshTarget =
    environment.entry.target._tag === "SshConnectionTarget" &&
    Option.isSome(environment.entry.profile) &&
    environment.entry.profile.value._tag === "SshConnectionProfile"
      ? environment.entry.profile.value.target
      : null;
  const metadataBits = [sshTarget ? `SSH ${formatDesktopSshTarget(sshTarget)}` : null].filter(
    (value): value is string => value !== null,
  );

  // The WSL backend is a desktop-managed local backend (it surfaces as a bearer
  // environment whose connection id is prefixed "local:"), not a remote
  // environment you connect to or remove here — its lifecycle is driven by the
  // WSL on/off + distro picker on this page.
  const isWslEnvironment = isDesktopLocalConnectionTarget(environment.entry.target);

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <ConnectionStatusDot
              tooltipText={statusTooltip}
              dotClassName={stateDotClassName}
              pingClassName={
                connectionState === "connecting" || connectionState === "reconnecting"
                  ? "bg-warning/60 duration-2000"
                  : null
              }
            />
            <h3 className="text-sm font-medium text-foreground">{environment.label}</h3>
          </div>
          {metadataBits.length > 0 ? (
            <p className="text-xs text-muted-foreground">{metadataBits.join(" · ")}</p>
          ) : null}
          {serverUpdateState.status !== "idle" ? (
            <div className="max-w-md">
              <ServerUpdateProgress state={serverUpdateState} />
            </div>
          ) : versionMismatch ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className="w-fit cursor-help rounded-sm text-left text-muted-foreground text-xs"
                  >
                    Server update available
                  </button>
                }
              />
              <TooltipPopup side="top">
                {versionMismatch.serverVersion} <span aria-hidden="true">→</span>{" "}
                {versionMismatch.clientVersion}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {environment.connection.error && !resumingServerUpdate ? (
            <p className="flex min-w-0 items-center gap-2 text-destructive text-xs">
              <Tooltip>
                <TooltipTrigger render={<span className="truncate" />}>
                  {statusTooltip}
                </TooltipTrigger>
                <TooltipPopup side="top" className="max-w-sm break-words">
                  {environment.connection.error}
                </TooltipPopup>
              </Tooltip>
              {errorTraceId ? (
                <button
                  type="button"
                  className="shrink-0 underline underline-offset-2"
                  onClick={() => copyTraceId(errorTraceId)}
                >
                  {t("Copy trace ID")}
                </button>
              ) : null}
            </p>
          ) : null}
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          {versionMismatch &&
          (serverUpdateState.status === "idle" || serverUpdateState.status === "failed") ? (
            <ServerUpdateAction
              environmentId={environmentId}
              serverLabel={`${environment.label} server`}
              selfUpdate={resolveServerSelfUpdateCapability(environment.serverConfig)}
              targetVersion={versionMismatch.clientVersion}
              label={serverUpdateState.status === "failed" ? "Retry" : "Update"}
            />
          ) : null}
          {isWslEnvironment ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button size="xs" variant="outline" disabled>
                    Managed above
                  </Button>
                }
              />
              <TooltipPopup side="top" presentation="connection-error">
                The WSL backend is managed by the WSL setting above — turn it on or off there.
              </TooltipPopup>
            </Tooltip>
          ) : (
            <>
              {!isConnected ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={removingEnvironmentId === environmentId}
                  onClick={() => void onRemove(environmentId)}
                >
                  {removingEnvironmentId === environmentId ? "Removing…" : "Remove"}
                </Button>
              ) : null}
              <Button
                size="xs"
                variant="outline"
                disabled={isConnecting || removingEnvironmentId === environmentId}
                onClick={() =>
                  void (isConnected ? onRemove(environmentId) : onConnect(environmentId))
                }
              >
                {isConnected
                  ? removingEnvironmentId === environmentId
                    ? "Disconnecting…"
                    : "Disconnect"
                  : isConnecting
                    ? "Connecting…"
                    : "Connect"}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

interface DesktopSshHostRowProps {
  target: DesktopDiscoveredSshHost;
  connectingHostAlias: string | null;
  onConnect: (target: DesktopDiscoveredSshHost) => void;
}

export const DesktopSshHostRow = memo(function DesktopSshHostRow({
  target,
  connectingHostAlias,
  onConnect,
}: DesktopSshHostRowProps) {
  const address = formatDesktopSshTarget(target);
  const showAddress = address !== target.alias;
  const buttonLabel = connectingHostAlias === target.alias ? "Adding…" : "Add environment";

  return (
    <div className="rounded-xl px-3 py-3 sm:px-4">
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium text-foreground">{target.alias}</h3>
          {showAddress ? <p className="truncate text-xs text-muted-foreground">{address}</p> : null}
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          <Button
            size="xs"
            variant="outline"
            disabled={connectingHostAlias === target.alias}
            onClick={() => onConnect(target)}
          >
            {connectingHostAlias === target.alias ? (
              <RefreshCwIcon className="size-3 animate-spin" />
            ) : null}
            {buttonLabel}
          </Button>
        </div>
      </div>
    </div>
  );
});

export function EmptyRemoteEnvironments() {
  return (
    <Empty className="min-h-52">
      <EmptyMedia variant="icon">
        <ChevronsLeftRightEllipsisIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>No other environments</EmptyTitle>
        <EmptyDescription>
          Add a server to work with its bots, chats, and projects from this client.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
