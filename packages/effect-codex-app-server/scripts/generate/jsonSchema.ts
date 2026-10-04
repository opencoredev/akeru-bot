import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { type GithubContentEntry } from "./upstream.ts";
import { type JsonSchemaFile } from "./types.ts";
import { exportNameForPath } from "./render.ts";

export function normalizeNullableTypes(value: Schema.Json): Schema.Json {
  if (Array.isArray(value)) {
    return value.map(normalizeNullableTypes);
  }

  if (
    value === null ||
    Predicate.isString(value) ||
    Predicate.isNumber(value) ||
    Predicate.isBoolean(value)
  ) {
    return value;
  }

  const normalizedEntries = Object.entries(value).map(([key, child]): [string, Schema.Json] => [
    key,
    normalizeNullableTypes(child),
  ]);

  const normalizedObject = Object.fromEntries(normalizedEntries);
  const typeValue = normalizedObject.type;

  if (!Array.isArray(typeValue)) {
    return normalizedObject;
  }

  const normalizedTypes = typeValue.filter((entry): entry is string => Predicate.isString(entry));

  if (normalizedTypes.length !== typeValue.length || !normalizedTypes.includes("null")) {
    return normalizedObject;
  }

  const nonNullTypes = normalizedTypes.filter((entry) => entry !== "null");

  if (nonNullTypes.length !== 1) {
    return normalizedObject;
  }

  const nonNullType = nonNullTypes[0]!;

  const nextObject: Record<string, Schema.Json> = {};

  for (const [key, child] of Object.entries(normalizedObject)) {
    if (key !== "type") {
      nextObject[key] = child;
    }
  }

  return {
    anyOf: [
      {
        ...nextObject,
        type: nonNullType,
      },
      { type: "null" },
    ],
  };
}

export function stripNullDefaults(value: Schema.Json): Schema.Json {
  if (Array.isArray(value)) {
    return value.map(stripNullDefaults);
  }

  if (
    value === null ||
    Predicate.isString(value) ||
    Predicate.isNumber(value) ||
    Predicate.isBoolean(value)
  ) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, child]) => !(key === "default" && child === null))
      .map(([key, child]) => [key, stripNullDefaults(child)]),
  );
}

export function buildJsonSchemaFiles(
  entries: ReadonlyArray<GithubContentEntry>,
): ReadonlyArray<JsonSchemaFile> {
  return entries.flatMap((entry) => {
    if (
      entry.type !== "file" ||
      !entry.name.endsWith(".json") ||
      entry.download_url === null ||
      entry.name.startsWith("codex_app_server_protocol.")
    )
      return [];
    const relative = entry.path.replace(/^codex-rs\/app-server-protocol\/schema\/json\//, "");
    const parts = relative.split("/");

    if (parts.length > 1) {
      return [
        {
          namespace: parts[0]!,
          exportName: exportNameForPath(relative),
          fileName: entry.name,
          downloadUrl: entry.download_url,
          qualifiedName: relative.replace(/\.json$/, ""),
        } satisfies JsonSchemaFile,
      ];
    }

    return [
      {
        exportName: exportNameForPath(relative),
        fileName: entry.name,
        downloadUrl: entry.download_url,
        qualifiedName: relative.replace(/\.json$/, ""),
      } satisfies JsonSchemaFile,
    ];
  });
}

export function rewriteExternalRefs(
  value: Schema.Json,
  localDefinitionNames: ReadonlyMap<string, string>,
  currentNamespace: string | undefined,
  exportNameByQualifiedName: ReadonlyMap<string, string>,
): Schema.Json {
  if (Array.isArray(value)) {
    return value.map((entry) =>
      rewriteExternalRefs(entry, localDefinitionNames, currentNamespace, exportNameByQualifiedName),
    );
  }

  if (
    value === null ||
    Predicate.isString(value) ||
    Predicate.isNumber(value) ||
    Predicate.isBoolean(value)
  ) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (key === "$ref" && Predicate.isString(child) && child.startsWith("#/definitions/")) {
        const definitionName = child.slice("#/definitions/".length);
        const localRewrite = localDefinitionNames.get(definitionName);

        if (localRewrite) {
          return [key, `#/definitions/${localRewrite}`];
        }

        const candidates = [
          ...(currentNamespace ? [`${currentNamespace}/${definitionName}`] : []),
          definitionName,
          definitionName.replace(/^v[12]\//, ""),
          definitionName.replace(/^serde_json\//, ""),
          `v2/${definitionName}`,
          `v1/${definitionName}`,
          `serde_json/${definitionName}`,
        ];

        const rewritten = candidates
          .map((candidate) => exportNameByQualifiedName.get(candidate))
          .find((candidate) => candidate !== undefined);

        if (!rewritten) {
          throw new Error(`Missing rewritten definition for ref: ${child}`);
        }

        return [key, `#/definitions/${rewritten}`];
      }

      return [
        key,
        rewriteExternalRefs(
          child,
          localDefinitionNames,
          currentNamespace,
          exportNameByQualifiedName,
        ),
      ];
    }),
  );
}
