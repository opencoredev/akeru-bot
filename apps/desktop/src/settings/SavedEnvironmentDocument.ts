import { EnvironmentId, type PersistedSavedEnvironmentRecord } from "@akeru/contracts";
import { fromLenientJson } from "@akeru/shared/schemaJson";

import * as Option from "effect/Option";

import * as Schema from "effect/Schema";

export type PersistedSavedEnvironmentDesktopSsh = NonNullable<
  PersistedSavedEnvironmentRecord["desktopSsh"]
>;

export interface PersistedSavedEnvironmentStorageRecord extends Omit<
  PersistedSavedEnvironmentRecord,
  "desktopSsh"
> {
  readonly desktopSsh?: PersistedSavedEnvironmentDesktopSsh;
  readonly relayManaged?: { readonly relayUrl: string };
  readonly encryptedBearerToken?: string;
}

export interface SavedEnvironmentRegistryDocument {
  readonly version: number;
  readonly records: readonly PersistedSavedEnvironmentStorageRecord[];
}

export interface SavedEnvironmentRegistryStorageDocument {
  readonly version?: number;
  readonly records?: readonly PersistedSavedEnvironmentStorageRecord[];
}

export const DesktopSshTargetSchema = Schema.Struct({
  alias: Schema.String,
  hostname: Schema.String,
  username: Schema.NullOr(Schema.String),
  port: Schema.NullOr(Schema.Number),
});

export const PersistedSavedEnvironmentStorageRecordSchema = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  httpBaseUrl: Schema.String,
  wsBaseUrl: Schema.String,
  createdAt: Schema.String,
  lastConnectedAt: Schema.NullOr(Schema.String),
  desktopSsh: Schema.optionalKey(DesktopSshTargetSchema),
  relayManaged: Schema.optionalKey(Schema.Struct({ relayUrl: Schema.String })),
  encryptedBearerToken: Schema.optionalKey(Schema.String),
});

export const SavedEnvironmentRegistryDocumentSchema = Schema.Struct({
  version: Schema.optionalKey(Schema.Number),
  records: Schema.optionalKey(Schema.Array(PersistedSavedEnvironmentStorageRecordSchema)),
});

export const SavedEnvironmentRegistryDocumentJson = fromLenientJson(
  SavedEnvironmentRegistryDocumentSchema,
);

export const decodeSavedEnvironmentRegistryDocumentJson = Schema.decodeEffect(
  SavedEnvironmentRegistryDocumentJson,
);

export const encodeSavedEnvironmentRegistryDocumentJson = Schema.encodeEffect(
  SavedEnvironmentRegistryDocumentJson,
);

export function toPersistedSavedEnvironmentRecord(
  record: PersistedSavedEnvironmentStorageRecord,
): PersistedSavedEnvironmentRecord {
  const nextRecord = {
    environmentId: record.environmentId,
    label: record.label,
    httpBaseUrl: record.httpBaseUrl,
    wsBaseUrl: record.wsBaseUrl,
    createdAt: record.createdAt,
    lastConnectedAt: record.lastConnectedAt,
  };
  return {
    ...nextRecord,
    ...(record.desktopSsh ? { desktopSsh: record.desktopSsh } : {}),
  };
}

export function toSavedEnvironmentStorageRecord(
  record: PersistedSavedEnvironmentRecord | PersistedSavedEnvironmentStorageRecord,
  encryptedBearerToken: Option.Option<string>,
): PersistedSavedEnvironmentStorageRecord {
  const nextRecord = {
    environmentId: record.environmentId,
    label: record.label,
    httpBaseUrl: record.httpBaseUrl,
    wsBaseUrl: record.wsBaseUrl,
    createdAt: record.createdAt,
    lastConnectedAt: record.lastConnectedAt,
  };
  const metadata = {
    ...(record.desktopSsh ? { desktopSsh: record.desktopSsh } : {}),
  };
  return Option.match(encryptedBearerToken, {
    onNone: () => ({ ...nextRecord, ...metadata }),
    onSome: (value) => ({ ...nextRecord, ...metadata, encryptedBearerToken: value }),
  });
}

export function normalizeSavedEnvironmentRegistryDocument(
  document: SavedEnvironmentRegistryStorageDocument,
): SavedEnvironmentRegistryDocument {
  return {
    version: document.version ?? 1,
    records: (document.records ?? []).filter((record) => record.relayManaged === undefined),
  };
}

export function preserveExistingSecrets(
  currentDocument: SavedEnvironmentRegistryDocument,
  records: readonly PersistedSavedEnvironmentRecord[],
): SavedEnvironmentRegistryDocument {
  const encryptedBearerTokenById = new Map(
    currentDocument.records.flatMap((record) =>
      record.encryptedBearerToken
        ? [[record.environmentId, record.encryptedBearerToken] as const]
        : [],
    ),
  );

  return {
    version: currentDocument.version,
    records: records.map((record) => {
      const encryptedBearerToken = encryptedBearerTokenById.get(record.environmentId);
      return toSavedEnvironmentStorageRecord(record, Option.fromNullishOr(encryptedBearerToken));
    }),
  };
}
