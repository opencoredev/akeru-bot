import { type MethodEntry } from "./types.ts";

function toPascalCaseMethod(method: string) {
  return method
    .split("/")
    .flatMap((segment) => segment.split(/(?=[A-Z])/))
    .flatMap((segment) => segment.split(/[-_]/))
    .filter(Boolean)
    .map((segment) => segment[0]!.toUpperCase() + segment.slice(1))
    .join("");
}

export function parseRequestEntries(fileContents: string): ReadonlyArray<MethodEntry> {
  const entryPattern = /\{\s*"method":\s*"([^"]+)",\s*id:\s*RequestId,\s*params:\s*([^,}]+)/g;
  const entries: Array<MethodEntry> = [];
  let match: RegExpExecArray | null;

  while ((match = entryPattern.exec(fileContents)) !== null) {
    entries.push({
      method: match[1]!,
      paramsType: match[2]!.trim(),
    });
  }

  return entries;
}

export function parseNotificationEntries(fileContents: string): ReadonlyArray<MethodEntry> {
  const entryPattern = /\{\s*"method":\s*"([^"]+)"(?:,\s*"params":\s*([^ }]+))?\s*\}/g;
  const entries: Array<MethodEntry> = [];
  let match: RegExpExecArray | null;

  while ((match = entryPattern.exec(fileContents)) !== null) {
    entries.push({
      method: match[1]!,
      ...(match[2] ? { paramsType: match[2].trim() } : {}),
    });
  }

  return entries;
}

export function resolveSchemaTypeName(
  rawTypeName: string,
  generatedSchemaNames: ReadonlySet<string>,
): string {
  if (rawTypeName === "undefined") {
    return "undefined";
  }

  const candidates = [
    rawTypeName,
    `V2${rawTypeName}`,
    `V1${rawTypeName}`,
    `SerdeJson${rawTypeName}`,
  ];

  for (const candidate of candidates) {
    if (generatedSchemaNames.has(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Unable to resolve schema type name: ${rawTypeName}`);
}

export function resolveResponseTypeName(
  method: string,
  paramsType: string | undefined,
  generatedSchemaNames: ReadonlySet<string>,
): string {
  const overrides = new Map<string, string>([
    ["account/logout", "LogoutAccountResponse"],
    ["account/rateLimits/read", "GetAccountRateLimitsResponse"],
    ["account/usage/read", "GetAccountTokenUsageResponse"],
    ["account/workspaceMessages/read", "GetWorkspaceMessagesResponse"],
    ["config/batchWrite", "ConfigWriteResponse"],
    ["config/mcpServer/reload", "McpServerRefreshResponse"],
    ["config/value/write", "ConfigWriteResponse"],
    ["configRequirements/read", "ConfigRequirementsReadResponse"],
    ["externalAgentConfig/import/readHistories", "ExternalAgentConfigImportHistoriesReadResponse"],
  ]);

  const override = overrides.get(method);

  if (override) {
    return resolveSchemaTypeName(override, generatedSchemaNames);
  }

  if (paramsType && paramsType !== "undefined") {
    const fromParams = paramsType.replace(/Params$/, "Response");

    try {
      return resolveSchemaTypeName(fromParams, generatedSchemaNames);
    } catch {
      // Fall through to method-based lookup.
    }
  }

  return resolveSchemaTypeName(`${toPascalCaseMethod(method)}Response`, generatedSchemaNames);
}
