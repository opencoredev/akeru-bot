import {
  AKERU_ENVIRONMENT_DESCRIPTOR_PATH,
  T3_ENVIRONMENT_DESCRIPTOR_PATH,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { environmentEndpointUrl } from "./endpoint.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiClient,
  RemoteEnvironmentAuthUndeclaredStatusError,
} from "../rpc/http.ts";

const DEFAULT_REMOTE_REQUEST_TIMEOUT_MS = 10_000;

const isMissingAkeruDescriptor = (
  error: unknown,
): error is RemoteEnvironmentAuthUndeclaredStatusError =>
  error instanceof RemoteEnvironmentAuthUndeclaredStatusError && error.status === 404;

export const fetchRemoteEnvironmentDescriptor = Effect.fn(
  "clientRuntime.environment.fetchRemoteEnvironmentDescriptor",
)(function* (input: { readonly httpBaseUrl: string; readonly timeoutMs?: number }) {
  const client = yield* makeEnvironmentHttpApiClient(input.httpBaseUrl);
  const timeoutMs = input.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS;
  const akeruUrl = environmentEndpointUrl(input.httpBaseUrl, AKERU_ENVIRONMENT_DESCRIPTOR_PATH);
  const t3Url = environmentEndpointUrl(input.httpBaseUrl, T3_ENVIRONMENT_DESCRIPTOR_PATH);
  return yield* executeEnvironmentHttpRequest(
    akeruUrl,
    timeoutMs,
    client.metadata.descriptor(),
  ).pipe(
    Effect.catchIf(isMissingAkeruDescriptor, () =>
      executeEnvironmentHttpRequest(t3Url, timeoutMs, client.metadata.descriptorT3()),
    ),
  );
});
