import {
  ClientPresentation,
  PrimaryEnvironmentAuth,
  SshEnvironmentGateway,
} from "@akeru/client-runtime/platform";
import { ConnectionBlockedError, ConnectionTransientError } from "@akeru/client-runtime/connection";
import {
  AuthStandardClientScopes,
  type DesktopBridge,
  type DesktopSshEnvironmentTarget,
} from "@akeru/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { readDesktopPrimaryBearerToken } from "../environments/primary/desktopAuth";
import { clientMetadata } from "./browserSignals";

function sshPreparationError(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause);

  if (message.toLowerCase().includes("cancel")) {
    return new ConnectionBlockedError({
      reason: "authentication",
      detail: message,
    });
  }

  return new ConnectionTransientError({
    reason: "remote-unavailable",
    detail: `Could not prepare the SSH environment: ${message}`,
  });
}

export const provisionDesktopSshEnvironment = Effect.fn(
  "web.connectionPlatform.ssh.provisionDesktop",
)(function* (
  bridge: Pick<
    DesktopBridge,
    "ensureSshEnvironment" | "fetchSshEnvironmentDescriptor" | "bootstrapSshBearerSession"
  >,
  target: DesktopSshEnvironmentTarget,
) {
  const bootstrap = yield* Effect.tryPromise({
    try: () =>
      bridge.ensureSshEnvironment(target, {
        issuePairingToken: true,
      }),
    catch: sshPreparationError,
  });

  const pairingToken = bootstrap.pairingToken;

  if (pairingToken === null) {
    return yield* new ConnectionBlockedError({
      reason: "authentication",
      detail: "The SSH environment did not issue a pairing credential.",
    });
  }

  const descriptor = yield* Effect.tryPromise({
    try: () => bridge.fetchSshEnvironmentDescriptor(bootstrap.httpBaseUrl),
    catch: sshPreparationError,
  });

  const access = yield* Effect.tryPromise({
    try: () => bridge.bootstrapSshBearerSession(bootstrap.httpBaseUrl, pairingToken),
    catch: sshPreparationError,
  });

  return {
    environmentId: descriptor.environmentId,
    label: descriptor.label,
    bootstrap,
    bearerToken: access.access_token,
  };
});

export const capabilitiesLayer = Layer.effectContext(
  Effect.sync(() => {
    const presentation = ClientPresentation.of({
      metadata: clientMetadata(),
      scopes: AuthStandardClientScopes,
    });

    const primaryAuth = PrimaryEnvironmentAuth.of({
      bearerToken: Effect.tryPromise({
        try: readDesktopPrimaryBearerToken,
        catch: (cause) =>
          new ConnectionTransientError({
            reason: "remote-unavailable",
            detail: `Could not load the desktop primary credential: ${String(cause)}`,
          }),
      }).pipe(Effect.map(Option.fromNullishOr)),
    });

    const ssh = SshEnvironmentGateway.of({
      provision: Effect.fn("web.connectionPlatform.ssh.provision")(function* (target) {
        const bridge = window.desktopBridge;

        if (bridge === undefined) {
          return yield* new ConnectionBlockedError({
            reason: "unsupported",
            detail: "SSH environments are only available in the desktop app.",
          });
        }

        return yield* provisionDesktopSshEnvironment(bridge, target);
      }),
      prepare: Effect.fn("web.connectionPlatform.ssh.prepare")(function* (input) {
        const bridge = window.desktopBridge;

        if (bridge === undefined) {
          return yield* new ConnectionBlockedError({
            reason: "unsupported",
            detail: "SSH environments are only available in the desktop app.",
          });
        }

        const bootstrap = yield* Effect.tryPromise({
          try: () =>
            bridge.ensureSshEnvironment(input.target, {
              issuePairingToken: true,
            }),
          catch: sshPreparationError,
        });

        if (bootstrap.pairingToken === null) {
          return yield* new ConnectionBlockedError({
            reason: "authentication",
            detail: "The SSH environment did not issue a pairing credential.",
          });
        }

        const access = yield* Effect.tryPromise({
          try: () =>
            bridge.bootstrapSshBearerSession(bootstrap.httpBaseUrl, bootstrap.pairingToken!),
          catch: sshPreparationError,
        });

        return {
          bootstrap,
          bearerToken: access.access_token,
        };
      }),
      disconnect: Effect.fn("web.connectionPlatform.ssh.disconnect")(function* (target) {
        const bridge = window.desktopBridge;

        if (bridge === undefined) {
          return;
        }

        yield* Effect.tryPromise({
          try: () => bridge.disconnectSshEnvironment(target),
          catch: (cause) =>
            new ConnectionTransientError({
              reason: "remote-unavailable",
              detail: `Could not disconnect the SSH environment: ${String(cause)}`,
            }),
        });
      }),
    });

    return Context.make(PrimaryEnvironmentAuth, primaryAuth).pipe(
      Context.add(ClientPresentation, presentation),
      Context.add(SshEnvironmentGateway, ssh),
    );
  }),
);
