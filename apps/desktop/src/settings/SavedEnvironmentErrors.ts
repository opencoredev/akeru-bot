import * as Schema from "effect/Schema";

export const DesktopSavedEnvironmentsWriteOperation = Schema.Literals([
  "create-temporary-file-name",
  "encode-registry",
  "create-directory",
  "write-temporary-file",
  "replace-registry-file",
]);

export const DesktopSavedEnvironmentSecretProtectionOperation = Schema.Literals([
  "check-encryption-availability",
  "encrypt-secret",
  "decrypt-secret",
]);

export class DesktopSavedEnvironmentsWriteError extends Schema.TaggedErrorClass<DesktopSavedEnvironmentsWriteError>()(
  "DesktopSavedEnvironmentsWriteError",
  {
    operation: DesktopSavedEnvironmentsWriteOperation,
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop saved-environment write failed during ${this.operation} at ${this.path}.`;
  }
}

export class DesktopSavedEnvironmentsReadError extends Schema.TaggedErrorClass<DesktopSavedEnvironmentsReadError>()(
  "DesktopSavedEnvironmentsReadError",
  {
    registryPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read desktop saved environments at ${this.registryPath}.`;
  }
}

export class DesktopSavedEnvironmentsDocumentDecodeError extends Schema.TaggedErrorClass<DesktopSavedEnvironmentsDocumentDecodeError>()(
  "DesktopSavedEnvironmentsDocumentDecodeError",
  {
    registryPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode desktop saved environments at ${this.registryPath}.`;
  }
}

export class DesktopSavedEnvironmentSecretDecodeError extends Schema.TaggedErrorClass<DesktopSavedEnvironmentSecretDecodeError>()(
  "DesktopSavedEnvironmentSecretDecodeError",
  {
    environmentId: Schema.String,
    registryPath: Schema.String,
    field: Schema.Literal("encryptedBearerToken"),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode ${this.field} for environment ${this.environmentId} at ${this.registryPath}.`;
  }
}

export class DesktopSavedEnvironmentSecretProtectionError extends Schema.TaggedErrorClass<DesktopSavedEnvironmentSecretProtectionError>()(
  "DesktopSavedEnvironmentSecretProtectionError",
  {
    operation: DesktopSavedEnvironmentSecretProtectionOperation,
    environmentId: Schema.String,
    registryPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop saved-environment secret protection failed during ${this.operation} for environment ${this.environmentId} at ${this.registryPath}.`;
  }
}

export type DesktopSavedEnvironmentsReadRegistryError =
  | DesktopSavedEnvironmentsReadError
  | DesktopSavedEnvironmentsDocumentDecodeError;

export type DesktopSavedEnvironmentsMutationError =
  | DesktopSavedEnvironmentsReadRegistryError
  | DesktopSavedEnvironmentsWriteError;

export type DesktopSavedEnvironmentsGetSecretError =
  | DesktopSavedEnvironmentsReadRegistryError
  | DesktopSavedEnvironmentSecretDecodeError
  | DesktopSavedEnvironmentSecretProtectionError;

export type DesktopSavedEnvironmentsSetSecretError =
  | DesktopSavedEnvironmentsMutationError
  | DesktopSavedEnvironmentSecretProtectionError;
