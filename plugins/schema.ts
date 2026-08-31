import {
  PLUGIN_APPROVAL_CLASSES,
  PLUGIN_CATEGORIES,
  type PluginApprovalClass,
  type CatalogCategory,
} from "./categories.ts";

export const PLUGIN_SCHEMA_VERSION = 1 as const;

type PluginPlatform = "web" | "desktop" | "mobile" | "macos" | "windows" | "linux";
type PluginAuthentication = "none" | "oauth" | "optional-oauth" | "api-key";
type PluginCatalogStatus = "available" | "approval-pending" | "deprecated";

interface Party {
  readonly name: string;
  readonly url: string;
}

interface PluginLogoManifest {
  readonly provenance: { readonly sourceUrl: string; readonly license: string };
}

type PluginTransport =
  | { readonly type: "url"; readonly url: string }
  | { readonly type: "stdio"; readonly command: string; readonly args?: readonly string[] }
  | { readonly type: "unavailable" };

type PluginConnection =
  | { readonly type: "ready" }
  | { readonly type: "api-key" }
  | { readonly type: "local" }
  | { readonly type: "brokered"; readonly broker: Party }
  | { readonly type: "approval-pending"; readonly blocker: string };

export interface PluginSkill {
  readonly title: string;
  readonly description: string;
  readonly url: string;
}

interface PluginPermission {
  readonly id: string;
  readonly description: string;
  readonly approval: "read" | PluginApprovalClass;
}

export interface PluginManifest {
  readonly schemaVersion: typeof PLUGIN_SCHEMA_VERSION;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly primaryCategory: CatalogCategory;
  readonly tags: readonly string[];
  readonly capabilities: readonly string[];
  readonly featuredRank?: number;
  readonly publisher: Party;
  readonly maintainer: Party;
  readonly documentationUrl: string;
  readonly sourceUrl: string;
  readonly license: string;
  readonly logo: PluginLogoManifest;
  readonly platforms: readonly PluginPlatform[];
  readonly transport: PluginTransport;
  readonly connection: PluginConnection;
  readonly authentication: PluginAuthentication;
  readonly requiredCredentials: readonly string[];
  readonly setup: readonly string[];
  readonly permissions: readonly PluginPermission[];
  readonly approvals: readonly PluginApprovalClass[];
  readonly catalogStatus: PluginCatalogStatus;
  readonly skills?: readonly PluginSkill[];
}

const PLUGIN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ABSOLUTE_FILE_PATH = /(?:^|=)(?:\/|[a-z]:[\\/]|\\\\)/i;
const CREDENTIAL_ARGUMENT =
  /(?:^|[^a-z0-9])(?:api[-_]?key|access[-_]?token|auth[-_]?token|token|password|secret)(?:[^a-z0-9]|$)/i;
const PLATFORMS: readonly PluginPlatform[] = [
  "web",
  "desktop",
  "mobile",
  "macos",
  "windows",
  "linux",
];
const AUTHENTICATION: readonly PluginAuthentication[] = [
  "none",
  "oauth",
  "optional-oauth",
  "api-key",
];
const CATALOG_STATUSES: readonly PluginCatalogStatus[] = [
  "available",
  "approval-pending",
  "deprecated",
];

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const unexpected = Object.keys(value).filter((key) => !keys.includes(key));
  if (unexpected.length > 0) {
    throw new TypeError(`${path} has unknown fields: ${unexpected.join(", ")}.`);
  }
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${path} must be a non-empty string.`);
  }
  return value;
}

function pluginId(value: unknown, path: string): string {
  const id = nonEmptyString(value, path);
  if (!PLUGIN_ID.test(id)) throw new TypeError(`${path} must use stable kebab-case.`);
  return id;
}

function literal<const T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new TypeError(`${path} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

function strings(value: unknown, path: string, ids = false): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array.`);
  return value.map((item, index) =>
    ids ? pluginId(item, `${path}[${index}]`) : nonEmptyString(item, `${path}[${index}]`),
  );
}

function secureUrl(value: unknown, path: string): string {
  const input = nonEmptyString(value, path);
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new TypeError(`${path} must be an absolute HTTPS URL.`);
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new TypeError(`${path} must use HTTPS and must not contain credentials.`);
  }
  return input;
}

function endpointUrl(value: unknown, path: string): string {
  const input = nonEmptyString(value, path);
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new TypeError(`${path} must be an absolute HTTP or HTTPS URL.`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new TypeError(`${path} must use HTTP or HTTPS and must not contain credentials.`);
  }
  return input;
}

function party(value: unknown, path: string): Party {
  const input = object(value, path);
  exactKeys(input, ["name", "url"], path);
  return {
    name: nonEmptyString(input.name, `${path}.name`),
    url: secureUrl(input.url, `${path}.url`),
  };
}

function logo(value: unknown, path: string): PluginLogoManifest {
  const input = object(value, path);
  exactKeys(input, ["provenance"], path);
  const provenance = object(input.provenance, `${path}.provenance`);
  exactKeys(provenance, ["sourceUrl", "license"], `${path}.provenance`);
  return {
    provenance: {
      sourceUrl: secureUrl(provenance.sourceUrl, `${path}.provenance.sourceUrl`),
      license: nonEmptyString(provenance.license, `${path}.provenance.license`),
    },
  };
}

function transport(value: unknown, path: string): PluginTransport {
  const input = object(value, path);
  if (input.type === "url") {
    exactKeys(input, ["type", "url"], path);
    return { type: "url", url: endpointUrl(input.url, `${path}.url`) };
  }
  if (input.type === "stdio") {
    exactKeys(input, ["type", "command", "args"], path);
    const args = input.args === undefined ? undefined : strings(input.args, `${path}.args`);
    return {
      type: "stdio",
      command: nonEmptyString(input.command, `${path}.command`),
      ...(args === undefined ? {} : { args }),
    };
  }
  if (input.type === "unavailable") {
    exactKeys(input, ["type"], path);
    return { type: "unavailable" };
  }
  throw new TypeError(`${path}.type must be url, stdio, or unavailable.`);
}

function connection(value: unknown, path: string): PluginConnection {
  const input = object(value, path);
  if (input.type === "brokered") {
    exactKeys(input, ["type", "broker"], path);
    return { type: "brokered", broker: party(input.broker, `${path}.broker`) };
  }
  if (input.type === "approval-pending") {
    exactKeys(input, ["type", "blocker"], path);
    return {
      type: "approval-pending",
      blocker: nonEmptyString(input.blocker, `${path}.blocker`),
    };
  }
  exactKeys(input, ["type"], path);
  return {
    type: literal(input.type, ["ready", "api-key", "local"] as const, `${path}.type`),
  };
}

function permissions(value: unknown, path: string): readonly PluginPermission[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array.`);
  return value.map((item, index) => {
    const input = object(item, `${path}[${index}]`);
    exactKeys(input, ["id", "description", "approval"], `${path}[${index}]`);
    return {
      id: pluginId(input.id, `${path}[${index}].id`),
      description: nonEmptyString(input.description, `${path}[${index}].description`),
      approval: literal(
        input.approval,
        ["read", ...PLUGIN_APPROVAL_CLASSES] as const,
        `${path}[${index}].approval`,
      ),
    };
  });
}

function skills(value: unknown, path: string): readonly PluginSkill[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array.`);
  return value.map((item, index) => {
    const input = object(item, `${path}[${index}]`);
    exactKeys(input, ["title", "description", "url"], `${path}[${index}]`);
    return {
      title: nonEmptyString(input.title, `${path}[${index}].title`),
      description: nonEmptyString(input.description, `${path}[${index}].description`),
      url: secureUrl(input.url, `${path}[${index}].url`),
    };
  });
}

function assertUnique(values: readonly string[], field: string, id: string): void {
  if (new Set(values).size !== values.length) {
    throw new TypeError(`Plugin '${id}' has duplicate ${field}.`);
  }
}

function decodePluginManifest(value: unknown): PluginManifest {
  const input = object(value, "plugin manifest");
  exactKeys(
    input,
    [
      "schemaVersion",
      "id",
      "name",
      "description",
      "primaryCategory",
      "tags",
      "capabilities",
      "featuredRank",
      "publisher",
      "maintainer",
      "documentationUrl",
      "sourceUrl",
      "license",
      "logo",
      "platforms",
      "transport",
      "connection",
      "authentication",
      "requiredCredentials",
      "setup",
      "permissions",
      "approvals",
      "catalogStatus",
      "skills",
    ],
    "plugin manifest",
  );
  if (input.schemaVersion !== PLUGIN_SCHEMA_VERSION) {
    throw new TypeError(`plugin manifest.schemaVersion must be ${PLUGIN_SCHEMA_VERSION}.`);
  }
  const featuredRank = input.featuredRank;
  if (
    featuredRank !== undefined &&
    (!Number.isInteger(featuredRank) || typeof featuredRank !== "number" || featuredRank < 1)
  ) {
    throw new TypeError("plugin manifest.featuredRank must be a positive integer.");
  }
  const parsedSkills =
    input.skills === undefined ? undefined : skills(input.skills, "plugin manifest.skills");
  return {
    schemaVersion: PLUGIN_SCHEMA_VERSION,
    id: pluginId(input.id, "plugin manifest.id"),
    name: nonEmptyString(input.name, "plugin manifest.name"),
    description: nonEmptyString(input.description, "plugin manifest.description"),
    primaryCategory: literal(
      input.primaryCategory,
      PLUGIN_CATEGORIES,
      "plugin manifest.primaryCategory",
    ),
    tags: strings(input.tags, "plugin manifest.tags"),
    capabilities: strings(input.capabilities, "plugin manifest.capabilities"),
    ...(featuredRank === undefined ? {} : { featuredRank }),
    publisher: party(input.publisher, "plugin manifest.publisher"),
    maintainer: party(input.maintainer, "plugin manifest.maintainer"),
    documentationUrl: secureUrl(input.documentationUrl, "plugin manifest.documentationUrl"),
    sourceUrl: secureUrl(input.sourceUrl, "plugin manifest.sourceUrl"),
    license: nonEmptyString(input.license, "plugin manifest.license"),
    logo: logo(input.logo, "plugin manifest.logo"),
    platforms: strings(input.platforms, "plugin manifest.platforms").map((platform, index) =>
      literal(platform, PLATFORMS, `plugin manifest.platforms[${index}]`),
    ),
    transport: transport(input.transport, "plugin manifest.transport"),
    connection: connection(input.connection, "plugin manifest.connection"),
    authentication: literal(input.authentication, AUTHENTICATION, "plugin manifest.authentication"),
    requiredCredentials: strings(
      input.requiredCredentials,
      "plugin manifest.requiredCredentials",
      true,
    ),
    setup: strings(input.setup, "plugin manifest.setup"),
    permissions: permissions(input.permissions, "plugin manifest.permissions"),
    approvals: strings(input.approvals, "plugin manifest.approvals").map((approval, index) =>
      literal(approval, PLUGIN_APPROVAL_CLASSES, `plugin manifest.approvals[${index}]`),
    ),
    catalogStatus: literal(input.catalogStatus, CATALOG_STATUSES, "plugin manifest.catalogStatus"),
    ...(parsedSkills === undefined ? {} : { skills: parsedSkills }),
  };
}

function validateManifest(manifest: PluginManifest): PluginManifest {
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
  if (manifest.authentication === "api-key" && manifest.connection.type !== "api-key") {
    throw new TypeError(`Plugin '${manifest.id}' must label its API key connection.`);
  }
  if (manifest.connection.type === "api-key" && manifest.authentication !== "api-key") {
    throw new TypeError(
      `Plugin '${manifest.id}' labels an API key connection without API key authentication.`,
    );
  }
  if (manifest.transport.type === "stdio" && manifest.connection.type !== "local") {
    throw new TypeError(`Plugin '${manifest.id}' must label its stdio connection as local.`);
  }
  if (
    manifest.transport.type === "unavailable" &&
    manifest.connection.type !== "approval-pending"
  ) {
    throw new TypeError(
      `Plugin '${manifest.id}' unavailable transport requires an approval blocker.`,
    );
  }
  if (manifest.catalogStatus === "available" && manifest.transport.type === "unavailable") {
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
      !(endpoint.protocol === "http:" && local && manifest.connection.type === "local")
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

export function parsePluginManifest(input: unknown, source = "plugin manifest"): PluginManifest {
  try {
    return validateManifest(decodePluginManifest(input));
  } catch (error) {
    throw new TypeError(`${source} is invalid: ${String(error)}`, { cause: error });
  }
}

export function parsePluginManifestJson(input: string, source = "plugin manifest"): PluginManifest {
  try {
    const value: unknown = JSON.parse(input);
    return validateManifest(decodePluginManifest(value));
  } catch (error) {
    throw new TypeError(`${source} is invalid: ${String(error)}`, { cause: error });
  }
}
