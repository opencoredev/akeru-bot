import * as Match from "effect/Match";
import type { EnvironmentId } from "@akeru/contracts";
import type { RemoteEnvironmentAuthError } from "../authorization/remote.ts";
import {
  ConnectionBlockedError,
  type ConnectionAttemptError,
  ConnectionTransientError,
} from "./model.ts";

export function profileMissingError(connectionId: string): ConnectionBlockedError {
  return new ConnectionBlockedError({
    reason: "configuration",
    detail: `Connection profile ${connectionId} is unavailable.`,
  });
}

export function credentialMissingError(connectionId: string): ConnectionBlockedError {
  return new ConnectionBlockedError({
    reason: "authentication",
    detail: `Connection credential ${connectionId} is unavailable.`,
  });
}

export function environmentMismatchError(input: {
  readonly expected: EnvironmentId;
  readonly actual: EnvironmentId;
}): ConnectionBlockedError {
  return new ConnectionBlockedError({
    reason: "configuration",
    detail: `Connected environment ${input.actual} does not match ${input.expected}.`,
  });
}

export function mapRemoteEnvironmentError(
  error: RemoteEnvironmentAuthError,
): ConnectionAttemptError {
  return Match.value(error).pipe(
    Match.tagsExhaustive({
      EnvironmentAuthInvalidError: (error) => {
        return new ConnectionBlockedError({
          reason: "authentication",
          detail: "The environment credential is invalid.",
          traceId: error.traceId,
        });
      },
      EnvironmentScopeRequiredError: (error) => {
        return new ConnectionBlockedError({
          reason: "permission",
          detail: "The environment credential does not grant the required access.",
          traceId: error.traceId,
        });
      },
      EnvironmentOperationForbiddenError: (error) => {
        return new ConnectionBlockedError({
          reason: "permission",
          detail: "The environment credential does not grant the required access.",
          traceId: error.traceId,
        });
      },
      EnvironmentRequestInvalidError: (error) => {
        return new ConnectionBlockedError({
          reason: "configuration",
          detail: "The environment rejected the authentication request.",
          traceId: error.traceId,
        });
      },
      EnvironmentResourceNotFoundError: (error) => {
        return new ConnectionBlockedError({
          reason: "configuration",
          detail: "The environment endpoint could not be found.",
          traceId: error.traceId,
        });
      },
      RemoteEnvironmentAuthTimeoutError: (error) => {
        return new ConnectionTransientError({
          reason: "timeout",
          detail: error.message,
        });
      },
      RemoteEnvironmentAuthFetchError: (error) => {
        return new ConnectionTransientError({
          reason: "network",
          detail: error.message,
        });
      },
      EnvironmentInternalError: (error) => {
        return new ConnectionTransientError({
          reason: "remote-unavailable",
          detail: "The environment could not authorize the connection.",
          traceId: error.traceId,
        });
      },
      RemoteEnvironmentAuthInvalidJsonError: (error) => {
        return new ConnectionTransientError({
          reason: "remote-unavailable",
          detail: error.message,
        });
      },
      RemoteEnvironmentAuthUndeclaredStatusError: (error) => {
        return new ConnectionTransientError({
          reason: "remote-unavailable",
          detail: error.message,
        });
      },
    }),
  );
}
