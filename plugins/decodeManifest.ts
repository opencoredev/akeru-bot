import { PLUGIN_APPROVAL_CLASSES, PLUGIN_CATEGORIES } from "./categories.ts";
import { PLUGIN_SCHEMA_VERSION, type PluginPlatform, type PluginAuthentication, type PluginCatalogStatus, type Party, type PluginLogoManifest, type PluginTransport, type PluginConnection, type PluginSkill, type PluginPermission, type PluginManifest, } from "./manifestTypes.ts";

const PLUGIN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
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
  "verification-pending",
  "deprecated",
];

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object.`);
  }
  // SAFETY: The guard rejects null, arrays, and primitives; property values remain unknown.
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
  const matched = allowed.find((candidate) => candidate === value);
  if (matched === undefined) {
    throw new TypeError(`${path} must be one of: ${allowed.join(", ")}.`);
  }
  return matched;
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
  exactKeys(input, ["provenance", "url"], path);
  const provenance = object(input.provenance, `${path}.provenance`);
  exactKeys(provenance, ["sourceUrl", "license"], `${path}.provenance`);
  return {
    ...(input.url === undefined ? {} : { url: secureUrl(input.url, `${path}.url`) }),
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
    exactKeys(input, ["type", "broker", "pendingBlocker"], path);
    return {
      type: "brokered",
      broker: party(input.broker, `${path}.broker`),
      ...(input.pendingBlocker === undefined
        ? {}
        : { pendingBlocker: nonEmptyString(input.pendingBlocker, `${path}.pendingBlocker`) }),
    };
  }
  if (input.type === "approval-pending" || input.type === "verification-pending") {
    exactKeys(input, ["type", "blocker"], path);
    return {
      type: input.type,
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

export function decodePluginManifest(value: unknown): PluginManifest {
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
