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
  type DesktopSshEnvironmentTarget,
  type DesktopServerExposureState,
  type EnvironmentId,
} from "@akeru/contracts";
import { useI18n } from "../../i18n";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@akeru/client-runtime/state/runtime";
import * as Option from "effect/Option";
import {
  isAdvertisedEndpointRemotelyReachable,
  parsePairingUrlFields,
} from "./ConnectionsSettings.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  revokeOtherServerClientSessions,
  revokeServerClientSession,
  revokeServerPairingLink,
  usePrimarySessionState,
  type ServerClientSessionRecord,
} from "~/environments/primary";
import { useUiStateStore } from "~/uiStateStore";
import { resolveServerConfigVersionMismatch } from "~/versionSkew";
import { authEnvironment } from "~/state/auth";
import { environmentCatalog } from "~/connection/catalog";
import {
  connectPairing as connectPairingAtom,
  connectSshEnvironment as connectSshEnvironmentAtom,
} from "~/connection/onboarding";
import { useEnvironmentQuery } from "~/state/query";
import {
  desktopNetworkAccessStateAtom,
  refreshDesktopNetworkAccessState,
} from "~/state/desktopNetworkAccess";
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
  parseManualDesktopSshTarget,
  parseRemotePairingFields,
  formatDesktopSshConnectionError,
  sortDesktopPairingLinks,
  sortDesktopClientSessions,
  toDesktopPairingLinkRecord,
  toDesktopClientSessionRecord,
  selectPairingEndpoint,
  isTailscaleHttpsEndpoint,
  endpointDefaultPreferenceKey,
} from "./connectionPresentation.logic";
import { PendingWslChange, useDesktopWslCommands } from "./useDesktopWslCommands";

const DEFAULT_TAILSCALE_SERVE_PORT = 443;

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
  PendingWslChange,
  useDesktopWslCommands,
} from "./useDesktopWslCommands";
