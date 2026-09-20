import { describe, expect, it } from "vite-plus/test";

import {
  AKERU_ENVIRONMENT_DESCRIPTOR_PATH,
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
  EnvironmentMetadataHttpApi,
  EnvironmentOperationForbiddenError,
  EnvironmentRequestInvalidError,
  EnvironmentResourceNotFoundError,
  EnvironmentScopeRequiredError,
  T3_ENVIRONMENT_DESCRIPTOR_PATH,
} from "./environmentHttp.ts";

const traceId = "trace-1";

describe("environment HTTP metadata", () => {
  it("publishes the Akeru discovery path and keeps the T3 alias", () => {
    expect(AKERU_ENVIRONMENT_DESCRIPTOR_PATH).toBe("/.well-known/akeru/environment");
    expect(T3_ENVIRONMENT_DESCRIPTOR_PATH).toBe("/.well-known/t3/environment");
    expect(EnvironmentMetadataHttpApi.endpoints.descriptor.path).toBe(
      AKERU_ENVIRONMENT_DESCRIPTOR_PATH,
    );
    expect(EnvironmentMetadataHttpApi.endpoints.descriptorT3.path).toBe(
      T3_ENVIRONMENT_DESCRIPTOR_PATH,
    );
  });
});

describe("environment HTTP errors", () => {
  // A client squashes the cause and shows `message`; an empty one becomes a generic
  // "The environment request failed." that names nothing the reader can act on.
  it("each carries a message that names its reason", () => {
    const errors = [
      new EnvironmentRequestInvalidError({
        code: "invalid_request",
        reason: "invalid_command",
        traceId,
      }),
      new EnvironmentAuthInvalidError({
        code: "auth_invalid",
        reason: "missing_credential",
        traceId,
      }),
      new EnvironmentScopeRequiredError({
        code: "insufficient_scope",
        requiredScope: "orchestration:read",
        traceId,
      }),
      new EnvironmentOperationForbiddenError({
        code: "operation_forbidden",
        reason: "current_session_revoke_not_allowed",
        traceId,
      }),
      new EnvironmentResourceNotFoundError({
        code: "not_found",
        reason: "thread_not_found",
        traceId,
      }),
      new EnvironmentInternalError({
        code: "internal_error",
        reason: "orchestration_snapshot_failed",
        traceId,
      }),
    ] as const;
    const details = [
      "invalid_command",
      "missing_credential",
      "orchestration:read",
      "current_session_revoke_not_allowed",
      "thread_not_found",
      "orchestration_snapshot_failed",
    ];
    errors.forEach((error, index) => {
      expect(error.message).toContain(details[index]);
    });
  });
});
