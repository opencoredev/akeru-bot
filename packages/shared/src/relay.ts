import type { RelayRouteBinding } from "@t3tools/contracts";

export type RelayBindingRejectionReason =
  | "unsupported-protocol"
  | "route-mismatch"
  | "environment-mismatch";

export type RelaySecretRejectionReason = "missing-enrollment-secret" | "enrollment-secret-mismatch";

export type RelayAttachmentValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: RelayBindingRejectionReason | RelaySecretRejectionReason;
    };

const utf8 = new TextEncoder();

const equalSecret = (left: string, right: string): boolean => {
  const leftBytes = utf8.encode(left);
  const rightBytes = utf8.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
};

/** Validates route and environment identity before any relay is attached. */
export const validateRelayRouteBinding = (input: {
  readonly offered: RelayRouteBinding;
  readonly expected: RelayRouteBinding;
}):
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: RelayBindingRejectionReason } => {
  if (input.offered.protocolVersion !== input.expected.protocolVersion) {
    return { ok: false, reason: "unsupported-protocol" };
  }
  if (input.offered.routeId !== input.expected.routeId) {
    return { ok: false, reason: "route-mismatch" };
  }
  if (input.offered.environmentId !== input.expected.environmentId) {
    return { ok: false, reason: "environment-mismatch" };
  }
  return { ok: true };
};

/**
 * Validates only the relay enrollment secret. Pairing credentials and bearer
 * sessions remain the environment auth layer's responsibility.
 */
export const validateRelayEnrollmentSecret = (input: {
  readonly provided: string | undefined;
  readonly expected: string;
}): { readonly ok: true } | { readonly ok: false; readonly reason: RelaySecretRejectionReason } => {
  if (!input.provided?.trim()) {
    return { ok: false, reason: "missing-enrollment-secret" };
  }
  return equalSecret(input.provided, input.expected)
    ? { ok: true }
    : { ok: false, reason: "enrollment-secret-mismatch" };
};

/** Runs route binding before enrollment validation and returns no secret data. */
export const validateRelayAttachment = (input: {
  readonly offered: RelayRouteBinding;
  readonly expected: RelayRouteBinding;
  readonly enrollmentSecret: string | undefined;
  readonly expectedEnrollmentSecret: string;
}): RelayAttachmentValidation => {
  const binding = validateRelayRouteBinding(input);
  if (!binding.ok) return binding;
  return validateRelayEnrollmentSecret({
    provided: input.enrollmentSecret,
    expected: input.expectedEnrollmentSecret,
  });
};
