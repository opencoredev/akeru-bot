import { type MethodEntry } from "./types.ts";

export function renderMethodConstants(constantName: string, entries: ReadonlyArray<MethodEntry>) {
  return [
    `export const ${constantName} = {`,
    ...entries.map(
      (entry) => `  ${JSON.stringify(entry.method)}: ${JSON.stringify(entry.method)},`,
    ),
    "} as const;",
    "",
  ].join("\n");
}

export function renderTypeInterface(
  interfaceName: string,
  entries: ReadonlyArray<MethodEntry>,
  typeName: (entry: MethodEntry) => string,
) {
  return [
    `export interface ${interfaceName} {`,
    ...entries.map((entry) => `  readonly ${JSON.stringify(entry.method)}: ${typeName(entry)};`),
    "}",
    "",
  ].join("\n");
}

export function renderSchemaMap(
  constantName: string,
  entries: ReadonlyArray<MethodEntry>,
  typeName: (entry: MethodEntry) => string,
) {
  return [
    `export const ${constantName} = {`,
    ...entries.map((entry) => {
      const schemaName = typeName(entry);
      return `  ${JSON.stringify(entry.method)}: ${
        schemaName === "undefined" ? "undefined" : `CodexSchema.${schemaName}`
      },`;
    }),
    "} as const;",
    "",
  ].join("\n");
}

export function renderSchemaTypeReference(schemaName: string) {
  return schemaName === "undefined" ? "undefined" : `CodexSchema.${schemaName}`;
}

export function exportNameForPath(filePath: string): string {
  const relative = filePath.replace(/^schema\/json\//, "").replace(/\.json$/, "");
  if (!relative.includes("/")) {
    return relative;
  }

  const [namespace, name] = relative.split("/", 2) as [string, string];
  const namespacePrefix = namespace
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((segment) => segment[0]!.toUpperCase() + segment.slice(1))
    .join("");
  return `${namespacePrefix}${name}`;
}
