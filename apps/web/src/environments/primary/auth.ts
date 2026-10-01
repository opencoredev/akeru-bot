import type { AuthSessionState } from "@akeru/contracts";
import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@akeru/contracts";
import {
  getPairingTokenFromUrl,
  stripPairingTokenFromUrl as stripPairingTokenUrl,
} from "../../pairingUrl";
import { PrimaryEnvironmentPairingCredentialRequiredError } from "./authErrors";
import {
  fetchSessionState,
  exchangeBootstrapCredential,
  waitForAuthenticatedSessionAfterBootstrap,
} from "./authBootstrap";

type ServerAuthGateState =
  | { status: "authenticated" }
  | {
      status: "requires-auth";
      auth: AuthSessionState["auth"];
      errorMessage?: string;
    };

let bootstrapPromise: Promise<ServerAuthGateState> | null = null;

let resolvedAuthenticatedGateState: ServerAuthGateState | null = null;

export function peekPairingTokenFromUrl(): string | null {
  return getPairingTokenFromUrl(new URL(window.location.href));
}

export function stripPairingTokenFromUrl() {
  const url = new URL(window.location.href);
  const next = stripPairingTokenUrl(url);

  if (next.toString() === url.toString()) {
    return;
  }

  window.history.replaceState({}, document.title, next.toString());
}

export function takePairingTokenFromUrl(): string | null {
  const token = peekPairingTokenFromUrl();

  if (!token) {
    return null;
  }

  stripPairingTokenFromUrl();

  return token;
}

function getDesktopBootstrapCredential(): string | null {
  // Both backends share the same bootstrap token (DesktopBackendConfiguration
  // mints one tokenRef and feeds it to both resolvers), so picking the
  // primary entry is fine even when the WSL backend is also registered.
  const bootstraps = window.desktopBridge?.getLocalEnvironmentBootstraps() ?? [];
  const primary = bootstraps.find((entry) => entry.id === PRIMARY_LOCAL_ENVIRONMENT_ID);

  return typeof primary?.bootstrapToken === "string" && primary.bootstrapToken.length > 0
    ? primary.bootstrapToken
    : null;
}

async function bootstrapServerAuth(): Promise<ServerAuthGateState> {
  const pairingCredential = takePairingTokenFromUrl();
  const currentSession = await fetchSessionState();

  if (currentSession.authenticated && !pairingCredential) {
    return { status: "authenticated" };
  }

  const bootstrapCredential = pairingCredential ?? getDesktopBootstrapCredential();

  if (!bootstrapCredential) {
    return {
      status: "requires-auth",
      auth: currentSession.auth,
    };
  }

  try {
    await exchangeBootstrapCredential(bootstrapCredential);
    await waitForAuthenticatedSessionAfterBootstrap();

    return { status: "authenticated" };
  } catch (error) {
    return {
      status: "requires-auth",
      auth: currentSession.auth,
      errorMessage: error instanceof Error ? error.message : "Authentication failed.",
    };
  }
}

export async function submitServerAuthCredential(credential: string): Promise<void> {
  const trimmedCredential = credential.trim();

  if (!trimmedCredential) {
    throw new PrimaryEnvironmentPairingCredentialRequiredError({
      providedLength: credential.length,
    });
  }

  resolvedAuthenticatedGateState = null;
  await exchangeBootstrapCredential(trimmedCredential);
  bootstrapPromise = null;
  stripPairingTokenFromUrl();
}

export async function resolveInitialServerAuthGateState(): Promise<ServerAuthGateState> {
  if (resolvedAuthenticatedGateState?.status === "authenticated" && !peekPairingTokenFromUrl()) {
    return resolvedAuthenticatedGateState;
  }

  if (bootstrapPromise) {
    return bootstrapPromise;
  }

  const nextPromise = bootstrapServerAuth();
  bootstrapPromise = nextPromise;

  return nextPromise
    .then((result) => {
      if (result.status === "authenticated") {
        resolvedAuthenticatedGateState = result;
      }

      return result;
    })
    .finally(() => {
      if (bootstrapPromise === nextPromise) {
        bootstrapPromise = null;
      }
    });
}

// Used by the WSL backend swap: invalidate the cached authenticated state
// (the new backend signs sessions with a different key) and re-bootstrap
// against the desktop bootstrap credential so the next WS reconnect doesn't
// hit 401 and start a reauth loop in the renderer.
export async function reauthenticatePrimaryEnvironment(): Promise<ServerAuthGateState> {
  resolvedAuthenticatedGateState = null;
  bootstrapPromise = null;

  return resolveInitialServerAuthGateState();
}

export function __resetServerAuthBootstrapForTests() {
  bootstrapPromise = null;
  resolvedAuthenticatedGateState = null;
}
export {
  PrimaryEnvironmentRequestError,
  isPrimaryEnvironmentRequestError,
  PrimaryEnvironmentPairingCredentialRejectedError,
  isPrimaryEnvironmentPairingCredentialRejectedError,
  PrimaryEnvironmentAuthSessionTimeoutError,
  isPrimaryEnvironmentAuthSessionTimeoutError,
  PrimaryEnvironmentPairingCredentialRequiredError,
  isPrimaryEnvironmentPairingCredentialRequiredError,
} from "./authErrors";

export {
  type ServerPairingLinkRecord,
  type ServerClientSessionRecord,
  createServerPairingCredential,
  listServerPairingLinks,
  revokeServerPairingLink,
  listServerClientSessions,
  revokeServerClientSession,
  revokeOtherServerClientSessions,
} from "./authAdministration";

export { fetchSessionState, retryTransientBootstrap } from "./authBootstrap";
