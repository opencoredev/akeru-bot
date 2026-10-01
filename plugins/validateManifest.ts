import type { PluginManifest } from "./manifestTypes.ts";

const ABSOLUTE_FILE_PATH = /(?:^|=)(?:\/|[a-z]:[\\/]|\\\\)/i;
const CREDENTIAL_ARGUMENT =
  /(?:^|[^a-z0-9])(?:api[-_]?key|access[-_]?token|auth[-_]?token|token|password|secret)(?:[^a-z0-9]|$)/i;

function assertUnique(values: readonly string[], field: string, id: string): void {
  if (new Set(values).size !== values.length) {
    throw new TypeError(`Plugin '${id}' has duplicate ${field}.`);
  }
}

export function validateManifest(manifest: PluginManifest): PluginManifest {
  assertUnique(manifest.tags, "tags", manifest.id);
  assertUnique(manifest.capabilities, "capabilities", manifest.id);
  assertUnique(manifest.platforms, "platforms", manifest.id);
  assertUnique(manifest.requiredCredentials, "credential names", manifest.id);
  assertUnique(
    manifest.permissions.map((permission) => permission.id),
    "permissions",
    manifest.id,
  );
  assertUnique(manifest.approvals, "approval classes", manifest.id);
  if (manifest.setup.length === 0)
    throw new TypeError(`Plugin '${manifest.id}' needs setup instructions.`);
  if (manifest.permissions.length === 0) {
    throw new TypeError(`Plugin '${manifest.id}' must document its permissions.`);
  }
  if (manifest.capabilities.length === 0) {
    throw new TypeError(`Plugin '${manifest.id}' must document its capabilities.`);
  }
  if (manifest.authentication === "api-key" && manifest.requiredCredentials.length === 0) {
    throw new TypeError(`Plugin '${manifest.id}' must name its required API key credentials.`);
  }
  if (manifest.authentication !== "api-key" && manifest.requiredCredentials.length > 0) {
    throw new TypeError(
      `Plugin '${manifest.id}' declares credentials without API key authentication.`,
    );
  }
  if (
    manifest.authentication === "api-key" &&
    manifest.connection.type !== "api-key" &&
    manifest.connection.type !== "approval-pending" &&
    manifest.connection.type !== "verification-pending"
  ) {
    throw new TypeError(`Plugin '${manifest.id}' must label its API key connection.`);
  }
  if (manifest.connection.type === "api-key" && manifest.authentication !== "api-key") {
    throw new TypeError(
      `Plugin '${manifest.id}' labels an API key connection without API key authentication.`,
    );
  }
  if (
    manifest.transport.type === "stdio" &&
    manifest.connection.type !== "local" &&
    manifest.connection.type !== "verification-pending"
  ) {
    throw new TypeError(`Plugin '${manifest.id}' must label its stdio connection as local.`);
  }
  if (
    manifest.transport.type === "unavailable" &&
    manifest.connection.type !== "approval-pending" &&
    manifest.connection.type !== "brokered"
  ) {
    throw new TypeError(
      `Plugin '${manifest.id}' unavailable transport requires an approval blocker or a broker.`,
    );
  }
  if (
    manifest.catalogStatus === "available" &&
    manifest.transport.type === "unavailable" &&
    manifest.connection.type !== "brokered"
  ) {
    throw new TypeError(`Plugin '${manifest.id}' cannot be available without a transport recipe.`);
  }
  if (
    manifest.connection.type === "approval-pending" &&
    manifest.catalogStatus !== "approval-pending"
  ) {
    throw new TypeError(`Plugin '${manifest.id}' must use approval-pending catalog status.`);
  }
  if (
    manifest.catalogStatus === "approval-pending" &&
    manifest.connection.type !== "approval-pending"
  ) {
    throw new TypeError(`Plugin '${manifest.id}' must label its connection as approval-pending.`);
  }
  if (
    manifest.connection.type === "brokered" &&
    manifest.connection.pendingBlocker !== undefined &&
    manifest.catalogStatus !== "verification-pending"
  ) {
    throw new TypeError(
      `Plugin '${manifest.id}' must label its pending brokered connection as verification-pending.`,
    );
  }
  if (
    manifest.connection.type === "verification-pending" &&
    manifest.catalogStatus !== "verification-pending"
  ) {
    throw new TypeError(`Plugin '${manifest.id}' must use verification-pending catalog status.`);
  }
  if (
    manifest.catalogStatus === "verification-pending" &&
    manifest.connection.type !== "verification-pending" &&
    !(manifest.connection.type === "brokered" && manifest.connection.pendingBlocker !== undefined)
  ) {
    throw new TypeError(
      `Plugin '${manifest.id}' must label its connection as verification-pending.`,
    );
  }
  if (
    manifest.transport.type === "stdio" &&
    manifest.transport.command.trim() !== manifest.transport.command
  ) {
    throw new TypeError(`Plugin '${manifest.id}' has an invalid stdio command.`);
  }
  if (manifest.transport.type === "stdio" && ABSOLUTE_FILE_PATH.test(manifest.transport.command)) {
    throw new TypeError(`Plugin '${manifest.id}' stdio command must not use an absolute path.`);
  }
  if (manifest.transport.type === "stdio") {
    for (const argument of manifest.transport.args ?? []) {
      if (ABSOLUTE_FILE_PATH.test(argument)) {
        throw new TypeError(`Plugin '${manifest.id}' stdio arguments must not use absolute paths.`);
      }
      if (CREDENTIAL_ARGUMENT.test(argument)) {
        throw new TypeError(
          `Plugin '${manifest.id}' stdio arguments must not contain credentials.`,
        );
      }
    }
  }
  if (manifest.transport.type === "url") {
    const endpoint = new URL(manifest.transport.url);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
    if (
      endpoint.protocol !== "https:" &&
      !(
        endpoint.protocol === "http:" &&
        local &&
        (manifest.connection.type === "local" ||
          manifest.connection.type === "approval-pending" ||
          manifest.connection.type === "verification-pending")
      )
    ) {
      throw new TypeError(
        `Plugin '${manifest.id}' endpoint must use HTTPS unless it is a local loopback connection.`,
      );
    }
  }
  const approvals = new Set(manifest.approvals);
  for (const permission of manifest.permissions) {
    if (permission.approval !== "read" && !approvals.has(permission.approval)) {
      throw new TypeError(
        `Plugin '${manifest.id}' permission '${permission.id}' requires '${permission.approval}' approval.`,
      );
    }
  }
  return Object.freeze(manifest);
}
