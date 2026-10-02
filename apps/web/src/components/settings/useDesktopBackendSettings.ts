import { Predicate } from "effect";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useMemo, useState } from "react";
import {
  AuthAccessWriteScope,
  AuthAdministrativeScopes,
  type AuthClientSession,
  type AuthPairingLink,
  type AdvertisedEndpoint,
  type DesktopDiscoveredSshHost,
  type DesktopServerExposureState,
  type EnvironmentId,
} from "@akeru/contracts";
import { useI18n } from "../../i18n";
import * as Option from "effect/Option";
import {
  isAdvertisedEndpointRemotelyReachable,
  parsePairingUrlFields,
} from "./ConnectionsSettings.logic";
import { usePrimarySessionState } from "~/environments/primary";
import { useUiStateStore } from "~/uiStateStore";
import { resolveServerConfigVersionMismatch } from "~/versionSkew";
import { authEnvironment } from "~/state/auth";
import { environmentCatalog } from "~/connection/catalog";
import {
  connectPairing as connectPairingAtom,
  connectSshEnvironment as connectSshEnvironmentAtom,
} from "~/connection/onboarding";
import { useEnvironmentQuery } from "~/state/query";
import { desktopNetworkAccessStateAtom } from "~/state/desktopNetworkAccess";
import { desktopSshHostsStateAtom } from "~/state/desktopSshHosts";
import { desktopWslStateAtom } from "~/state/desktopWslState";
import {
  type EnvironmentPresentation,
  useEnvironments,
  usePrimaryEnvironment,
} from "~/state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { serverEnvironment } from "~/state/server";
import {
  formatDesktopSshTarget,
  sortDesktopPairingLinks,
  sortDesktopClientSessions,
  toDesktopPairingLinkRecord,
  toDesktopClientSessionRecord,
  selectPairingEndpoint,
  isTailscaleHttpsEndpoint,
  endpointDefaultPreferenceKey,
} from "./connectionPresentation.logic";
import { PendingWslChange, useDesktopWslCommands } from "./useDesktopWslCommands";
import {
  DEFAULT_TAILSCALE_SERVE_PORT,
  useDesktopExposureCommands,
} from "./useDesktopExposureCommands";
import { useDesktopAccessCommands } from "./useDesktopAccessCommands";
import { useSavedBackendCommands } from "./useSavedBackendCommands";

const EMPTY_ADVERTISED_ENDPOINTS: ReadonlyArray<AdvertisedEndpoint> = [];

const EMPTY_DISCOVERED_SSH_HOSTS: ReadonlyArray<DesktopDiscoveredSshHost> = [];

export function useDesktopBackendSettings() {
  const { t } = useI18n();

  const desktopBridge = window.desktopBridge;

  const { environments } = useEnvironments();

  const primaryEnvironment = usePrimaryEnvironment();

  const connectPairing = useAtomCommand(connectPairingAtom, { reportFailure: false });

  const connectSshEnvironment = useAtomCommand(connectSshEnvironmentAtom, {
    reportFailure: false,
  });

  const removeEnvironment = useAtomCommand(environmentCatalog.remove, { reportFailure: false });

  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });

  const primaryEnvironmentId = primaryEnvironment?.environmentId ?? null;

  const primarySessionState = usePrimarySessionState();

  const currentSessionScopes = desktopBridge
    ? AuthAdministrativeScopes
    : primarySessionState.data?.authenticated
      ? (primarySessionState.data.scopes ?? null)
      : null;

  const currentAuthPolicy = desktopBridge ? null : (primarySessionState.data?.auth.policy ?? null);

  const savedEnvironments = useMemo(
    () =>
      environments
        .filter(
          (environment) => !Predicate.isTagged(environment.entry.target, "PrimaryConnectionTarget"),
        )
        .toSorted((left, right) => left.label.localeCompare(right.label)),
    [environments],
  );

  const savedDesktopSshEnvironmentsByAlias = useMemo(
    () =>
      savedEnvironments.reduce<Record<string, EnvironmentPresentation>>(
        (accumulator, environment) => {
          const profile = environment.entry.profile;

          if (
            Predicate.isTagged(environment.entry.target, "SshConnectionTarget") &&
            Option.isSome(profile) &&
            Predicate.isTagged(profile.value, "SshConnectionProfile")
          ) {
            accumulator[profile.value.target.alias] = environment;
          }

          return accumulator;
        },
        {},
      ),
    [savedEnvironments],
  );

  const savedDesktopSshEnvironmentKeys = useMemo(() => {
    const keys = new Set<string>();

    for (const environment of savedEnvironments) {
      const profile = environment.entry.profile;

      if (
        !Predicate.isTagged(environment.entry.target, "SshConnectionTarget") ||
        Option.isNone(profile) ||
        !Predicate.isTagged(profile.value, "SshConnectionProfile")
      ) {
        continue;
      }

      const target = profile.value.target;
      keys.add(target.alias);
      keys.add(formatDesktopSshTarget(target));
    }

    return keys;
  }, [savedEnvironments]);

  const [sshConnectionError, setSshConnectionError] = useState<string | null>(null);

  const [connectingSshHostAlias, setConnectingSshHostAlias] = useState<string | null>(null);

  const [desktopServerExposureMutationError, setDesktopServerExposureMutationError] = useState<
    string | null
  >(null);

  const [desktopAccessManagementMutationError, setDesktopAccessManagementMutationError] = useState<
    string | null
  >(null);

  const [revokingDesktopPairingLinkId, setRevokingDesktopPairingLinkId] = useState<string | null>(
    null,
  );

  const [revokingDesktopClientSessionId, setRevokingDesktopClientSessionId] = useState<
    string | null
  >(null);

  const [isRevokingOtherDesktopClients, setIsRevokingOtherDesktopClients] = useState(false);

  const [addBackendDialogOpen, setAddBackendDialogOpen] = useState(false);

  const [savedBackendMode, setSavedBackendMode] = useState<"remote" | "ssh">("remote");

  const [savedBackendHost, setSavedBackendHost] = useState("");

  const [savedBackendPairingCode, setSavedBackendPairingCode] = useState("");

  const [savedBackendSshHost, setSavedBackendSshHost] = useState("");

  const [savedBackendSshUsername, setSavedBackendSshUsername] = useState("");

  const [savedBackendSshPort, setSavedBackendSshPort] = useState("");

  const [savedBackendError, setSavedBackendError] = useState<string | null>(null);

  const [isAddingSavedBackend, setIsAddingSavedBackend] = useState(false);

  const [removingSavedEnvironmentId, setRemovingSavedEnvironmentId] =
    useState<EnvironmentId | null>(null);

  const [isUpdatingDesktopServerExposure, setIsUpdatingDesktopServerExposure] = useState(false);

  const [isDesktopServerExposureDialogOpen, setIsDesktopServerExposureDialogOpen] = useState(false);

  const [isUpdatingTailscaleServe, setIsUpdatingTailscaleServe] = useState(false);

  const [isUpdatingWslBackend, setIsUpdatingWslBackend] = useState(false);

  const [desktopWslMutationError, setDesktopWslMutationError] = useState<string | null>(null);

  const [pendingWslChange, setPendingWslChange] = useState<PendingWslChange | null>(null);

  const isWslConfirmDialogOpen = pendingWslChange !== null;

  const [pendingTailscaleServeEndpoint, setPendingTailscaleServeEndpoint] =
    useState<AdvertisedEndpoint | null>(null);

  const [disableTailscaleServeDialogOpen, setDisableTailscaleServeDialogOpen] = useState(false);

  const [tailscaleServePortInput, setTailscaleServePortInput] = useState(
    String(DEFAULT_TAILSCALE_SERVE_PORT),
  );

  const [pendingDesktopServerExposureMode, setPendingDesktopServerExposureMode] = useState<
    DesktopServerExposureState["mode"] | null
  >(null);

  const primaryServerConfig = primaryEnvironment?.serverConfig ?? null;

  const primaryVersionMismatch = resolveServerConfigVersionMismatch(primaryServerConfig);

  const primaryServerUpdateState = useAtomValue(
    serverEnvironment.updateStateAtom(primaryEnvironmentId),
  );

  const [isAdvertisedEndpointListExpanded, setIsAdvertisedEndpointListExpanded] = useState(false);

  const defaultAdvertisedEndpointKey = useUiStateStore(
    (state) => state.defaultAdvertisedEndpointKey,
  );

  const setDefaultAdvertisedEndpointKey = useUiStateStore(
    (state) => state.setDefaultAdvertisedEndpointKey,
  );

  const canManageLocalBackend = currentSessionScopes?.includes(AuthAccessWriteScope) ?? false;

  const authAccessChanges = useEnvironmentQuery(
    canManageLocalBackend && primaryEnvironmentId !== null
      ? authEnvironment.accessChanges({
          environmentId: primaryEnvironmentId,
          input: null,
        })
      : null,
  );

  const desktopNetworkAccess = useEnvironmentQuery(
    canManageLocalBackend && desktopBridge ? desktopNetworkAccessStateAtom : null,
  );

  const desktopSshHosts = useEnvironmentQuery(
    desktopBridge && addBackendDialogOpen && savedBackendMode === "ssh"
      ? desktopSshHostsStateAtom
      : null,
  );

  const desktopWsl = useEnvironmentQuery(
    canManageLocalBackend && desktopBridge ? desktopWslStateAtom : null,
  );

  const desktopWslState = desktopWsl.data;

  const desktopWslError = desktopWslMutationError ?? desktopWsl.error;

  const isLoadingWslState = desktopWsl.isPending && desktopWsl.data === null;

  const discoveredSshHosts = desktopSshHosts.data ?? EMPTY_DISCOVERED_SSH_HOSTS;

  const unsavedDiscoveredSshHosts = useMemo(
    () =>
      discoveredSshHosts.filter((target) => {
        const address = formatDesktopSshTarget(target);

        return (
          !savedDesktopSshEnvironmentKeys.has(target.alias) &&
          !savedDesktopSshEnvironmentKeys.has(address)
        );
      }),
    [discoveredSshHosts, savedDesktopSshEnvironmentKeys],
  );

  const hasLoadedDiscoveredSshHosts =
    desktopSshHosts.data !== null || desktopSshHosts.error !== null;

  const isLoadingDiscoveredSshHosts = desktopSshHosts.isPending;

  const discoveredSshHostsError = sshConnectionError ?? desktopSshHosts.error;

  const desktopServerExposureState = desktopNetworkAccess.data?.serverExposureState ?? null;

  const desktopAdvertisedEndpoints =
    desktopNetworkAccess.data?.advertisedEndpoints ?? EMPTY_ADVERTISED_ENDPOINTS;

  const desktopServerExposureError =
    desktopServerExposureMutationError ?? desktopNetworkAccess.error;

  const desktopAccessManagementError =
    desktopAccessManagementMutationError ?? authAccessChanges.error;

  const isLoadingDesktopAccessManagement =
    authAccessChanges.isPending && authAccessChanges.data === null;

  const desktopPairingLinks = useMemo(() => {
    const event = authAccessChanges.data;

    if (event?.type !== "snapshot") return [];

    return sortDesktopPairingLinks(
      event.payload.pairingLinks.map((pairingLink: AuthPairingLink) =>
        toDesktopPairingLinkRecord(pairingLink),
      ),
    );
  }, [authAccessChanges.data]);

  const desktopClientSessions = useMemo(() => {
    const event = authAccessChanges.data;

    if (event?.type !== "snapshot") return [];

    return sortDesktopClientSessions(
      event.payload.clientSessions.map((clientSession: AuthClientSession) =>
        toDesktopClientSessionRecord(clientSession),
      ),
    );
  }, [authAccessChanges.data]);

  const isLocalBackendNetworkAccessible = desktopBridge
    ? desktopServerExposureState?.mode === "network-accessible"
    : currentAuthPolicy === "remote-reachable";

  const trimmedTailscaleServePortInput = tailscaleServePortInput.trim();

  const parsedTailscaleServePort = Number(trimmedTailscaleServePortInput);

  const isTailscaleServePortValid =
    /^\d+$/u.test(trimmedTailscaleServePortInput) &&
    Number.isInteger(parsedTailscaleServePort) &&
    parsedTailscaleServePort >= 1 &&
    parsedTailscaleServePort <= 65_535;

  const pendingTailscaleServeBaseUrl = useMemo(() => {
    if (!pendingTailscaleServeEndpoint) return null;

    if (!isTailscaleServePortValid) return pendingTailscaleServeEndpoint.httpBaseUrl;

    if (parsedTailscaleServePort === DEFAULT_TAILSCALE_SERVE_PORT) {
      return pendingTailscaleServeEndpoint.httpBaseUrl;
    }

    try {
      const url = new URL(pendingTailscaleServeEndpoint.httpBaseUrl);
      url.port = String(parsedTailscaleServePort);

      return url.toString().replace(/\/$/u, "");
    } catch {
      return pendingTailscaleServeEndpoint.httpBaseUrl;
    }
  }, [isTailscaleServePortValid, parsedTailscaleServePort, pendingTailscaleServeEndpoint]);

  const {
    handleConfirmDesktopServerExposureChange,
    handleConfirmTailscaleServeSetup,
    handleStartTailscaleServeSetup,
    handleConfirmTailscaleServeDisable,
    handleStartTailscaleServeDisable,
  } = useDesktopExposureCommands({
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
  });

  const {
    handleRevokeDesktopPairingLink,
    handleRevokeDesktopClientSession,
    handleRevokeOtherDesktopClients,
  } = useDesktopAccessCommands({
    setRevokingDesktopPairingLinkId,
    setRevokingDesktopClientSessionId,
    setIsRevokingOtherDesktopClients,
    setDesktopAccessManagementMutationError,
  });

  const {
    handleAddSavedBackend,
    handleConnectSavedBackend,
    handleRemoveSavedBackend,
    handleConnectSshHost,
  } = useSavedBackendCommands({
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
  });

  const visibleDesktopPairingLinks = desktopPairingLinks;

  const tailscaleHttpsEndpoint = useMemo(
    () => desktopAdvertisedEndpoints.find(isTailscaleHttpsEndpoint) ?? null,
    [desktopAdvertisedEndpoints],
  );

  const visibleDesktopNetworkAdvertisedEndpoints = useMemo(
    () =>
      isLocalBackendNetworkAccessible
        ? desktopAdvertisedEndpoints.filter((endpoint) => !isTailscaleHttpsEndpoint(endpoint))
        : [],
    [desktopAdvertisedEndpoints, isLocalBackendNetworkAccessible],
  );

  const visibleDesktopAdvertisedEndpoints = useMemo(
    () =>
      tailscaleHttpsEndpoint
        ? [...visibleDesktopNetworkAdvertisedEndpoints, tailscaleHttpsEndpoint]
        : visibleDesktopNetworkAdvertisedEndpoints,
    [tailscaleHttpsEndpoint, visibleDesktopNetworkAdvertisedEndpoints],
  );

  // Desktop reports what it exposes; a browser has no endpoint list and relies
  // on the server's auth policy.
  const isLocalBackendRemotelyReachable = desktopBridge
    ? isAdvertisedEndpointRemotelyReachable(visibleDesktopAdvertisedEndpoints)
    : currentAuthPolicy === "remote-reachable";

  const defaultDesktopNetworkAdvertisedEndpoint = useMemo(
    () =>
      selectPairingEndpoint(visibleDesktopNetworkAdvertisedEndpoints, defaultAdvertisedEndpointKey),
    [defaultAdvertisedEndpointKey, visibleDesktopNetworkAdvertisedEndpoints],
  );

  const defaultDesktopAdvertisedEndpoint = useMemo(
    () =>
      defaultDesktopNetworkAdvertisedEndpoint ??
      selectPairingEndpoint(
        tailscaleHttpsEndpoint ? [tailscaleHttpsEndpoint] : [],
        defaultAdvertisedEndpointKey,
      ),
    [defaultAdvertisedEndpointKey, defaultDesktopNetworkAdvertisedEndpoint, tailscaleHttpsEndpoint],
  );

  const defaultDesktopAdvertisedEndpointKey = defaultDesktopAdvertisedEndpoint
    ? endpointDefaultPreferenceKey(defaultDesktopAdvertisedEndpoint)
    : null;

  const handleSetDefaultAdvertisedEndpoint = useCallback(
    (endpoint: AdvertisedEndpoint) => {
      setDefaultAdvertisedEndpointKey(endpointDefaultPreferenceKey(endpoint));
    },
    [setDefaultAdvertisedEndpointKey],
  );

  const handleSavedBackendHostChange = useCallback((value: string) => {
    const parsedPairingUrl = parsePairingUrlFields(value, window.location.origin);

    if (parsedPairingUrl) {
      setSavedBackendHost(parsedPairingUrl.host);
      setSavedBackendPairingCode(parsedPairingUrl.pairingCode);

      return;
    }

    setSavedBackendHost(value);
  }, []);

  const {
    loadWslState,
    handleSelectWslMode,
    handleConfirmEnableWsl,
    handleToggleWslOnly,
    handleConfirmWslChange,
  } = useDesktopWslCommands({
    desktopBridge,
    desktopWslState,
    environments,
    pendingWslChange,
    setPendingWslChange,
    setIsUpdatingWslBackend,
    setDesktopWslMutationError,
  });

  return {
    t,
    desktopBridge,
    primaryEnvironment,
    primaryEnvironmentId,
    currentAuthPolicy,
    savedEnvironments,
    connectingSshHostAlias,
    revokingDesktopPairingLinkId,
    revokingDesktopClientSessionId,
    isRevokingOtherDesktopClients,
    addBackendDialogOpen,
    setAddBackendDialogOpen,
    savedBackendMode,
    setSavedBackendMode,
    savedBackendHost,
    savedBackendPairingCode,
    setSavedBackendPairingCode,
    savedBackendSshHost,
    setSavedBackendSshHost,
    savedBackendSshUsername,
    setSavedBackendSshUsername,
    savedBackendSshPort,
    setSavedBackendSshPort,
    savedBackendError,
    setSavedBackendError,
    isAddingSavedBackend,
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
    isAdvertisedEndpointListExpanded,
    setIsAdvertisedEndpointListExpanded,
    canManageLocalBackend,
    desktopSshHosts,
    desktopWslState,
    desktopWslError,
    isLoadingWslState,
    unsavedDiscoveredSshHosts,
    hasLoadedDiscoveredSshHosts,
    isLoadingDiscoveredSshHosts,
    discoveredSshHostsError,
    desktopServerExposureState,
    desktopServerExposureError,
    desktopAccessManagementError,
    isLoadingDesktopAccessManagement,
    desktopClientSessions,
    isLocalBackendNetworkAccessible,
    isTailscaleServePortValid,
    pendingTailscaleServeBaseUrl,
    handleConfirmDesktopServerExposureChange,
    handleConfirmTailscaleServeSetup,
    handleStartTailscaleServeSetup,
    handleConfirmTailscaleServeDisable,
    handleStartTailscaleServeDisable,
    handleRevokeDesktopPairingLink,
    handleRevokeDesktopClientSession,
    handleRevokeOtherDesktopClients,
    handleAddSavedBackend,
    handleConnectSavedBackend,
    handleRemoveSavedBackend,
    handleConnectSshHost,
    visibleDesktopPairingLinks,
    tailscaleHttpsEndpoint,
    visibleDesktopNetworkAdvertisedEndpoints,
    visibleDesktopAdvertisedEndpoints,
    isLocalBackendRemotelyReachable,
    defaultDesktopNetworkAdvertisedEndpoint,
    defaultDesktopAdvertisedEndpointKey,
    handleSetDefaultAdvertisedEndpoint,
    handleSavedBackendHostChange,
    loadWslState,
    handleSelectWslMode,
    handleConfirmEnableWsl,
    handleToggleWslOnly,
    handleConfirmWslChange,
  };
}

export {
  BACKEND_VALUE_DEFAULT_WSL,
  BACKEND_VALUE_WSL_OFF,
  type PendingWslChange,
  useDesktopWslCommands,
} from "./useDesktopWslCommands";
