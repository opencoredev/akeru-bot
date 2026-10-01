import {
  type AuthEnvironmentScope,
  type AuthPairingLink,
  type ServerAuthBootstrapMethod,
} from "@akeru/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

export interface BootstrapGrant {
  readonly method: ServerAuthBootstrapMethod;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly subject: string;
  readonly label?: string;
  readonly expiresAt: DateTime.DateTime;
}

export class UnknownBootstrapCredentialError extends Schema.TaggedErrorClass<UnknownBootstrapCredentialError>()(
  "UnknownBootstrapCredentialError",
  {},
) {
  override get message(): string {
    return "Unknown bootstrap credential.";
  }
}

export class ExpiredBootstrapCredentialError extends Schema.TaggedErrorClass<ExpiredBootstrapCredentialError>()(
  "ExpiredBootstrapCredentialError",
  {},
) {
  override get message(): string {
    return "Bootstrap credential expired.";
  }
}

export class UnavailableBootstrapCredentialError extends Schema.TaggedErrorClass<UnavailableBootstrapCredentialError>()(
  "UnavailableBootstrapCredentialError",
  {},
) {
  override get message(): string {
    return "Bootstrap credential is no longer available.";
  }
}

export const BootstrapCredentialInvalidError = Schema.Union([
  UnknownBootstrapCredentialError,
  ExpiredBootstrapCredentialError,
  UnavailableBootstrapCredentialError,
]);

export type BootstrapCredentialInvalidError = typeof BootstrapCredentialInvalidError.Type;

export const isBootstrapCredentialInvalidError = Schema.is(BootstrapCredentialInvalidError);

export class ActivePairingLinksLoadError extends Schema.TaggedErrorClass<ActivePairingLinksLoadError>()(
  "ActivePairingLinksLoadError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to load active pairing links.";
  }
}

export class PairingLinkRevokeError extends Schema.TaggedErrorClass<PairingLinkRevokeError>()(
  "PairingLinkRevokeError",
  {
    pairingLinkId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to revoke pairing link '${this.pairingLinkId}'.`;
  }
}

export class PairingCredentialIssueError extends Schema.TaggedErrorClass<PairingCredentialIssueError>()(
  "PairingCredentialIssueError",
  {
    pairingLinkId: Schema.String,
    subject: Schema.String,
    label: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to issue pairing credential '${this.pairingLinkId}' for '${this.subject}'.`;
  }
}

export class PairingCredentialRandomGenerationError extends Schema.TaggedErrorClass<PairingCredentialRandomGenerationError>()(
  "PairingCredentialRandomGenerationError",
  {
    operation: Schema.Literals(["generate-id", "generate-token"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to generate pairing credential data during '${this.operation}'.`;
  }
}

export class BootstrapCredentialConsumeError extends Schema.TaggedErrorClass<BootstrapCredentialConsumeError>()(
  "BootstrapCredentialConsumeError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to consume bootstrap credential.";
  }
}

export class BootstrapCredentialConsumeAvailableError extends Schema.TaggedErrorClass<BootstrapCredentialConsumeAvailableError>()(
  "BootstrapCredentialConsumeAvailableError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to atomically consume an available bootstrap credential.";
  }
}

export class BootstrapCredentialLookupError extends Schema.TaggedErrorClass<BootstrapCredentialLookupError>()(
  "BootstrapCredentialLookupError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to look up bootstrap credential state.";
  }
}

export const BootstrapCredentialInternalError = Schema.Union([
  ActivePairingLinksLoadError,
  PairingLinkRevokeError,
  PairingCredentialIssueError,
  PairingCredentialRandomGenerationError,
  BootstrapCredentialConsumeError,
  BootstrapCredentialConsumeAvailableError,
  BootstrapCredentialLookupError,
]);

export type BootstrapCredentialInternalError = typeof BootstrapCredentialInternalError.Type;

export const isBootstrapCredentialInternalError = Schema.is(BootstrapCredentialInternalError);

export const BootstrapCredentialError = Schema.Union([
  BootstrapCredentialInvalidError,
  BootstrapCredentialInternalError,
]);

export type BootstrapCredentialError = typeof BootstrapCredentialError.Type;

export const isBootstrapCredentialError = Schema.is(BootstrapCredentialError);

export interface IssuedBootstrapCredential {
  readonly id: string;
  readonly credential: string;
  readonly label?: string;
  readonly expiresAt: DateTime.Utc;
}

export type BootstrapCredentialChange =
  | {
      readonly type: "pairingLinkUpserted";
      readonly pairingLink: AuthPairingLink;
    }
  | {
      readonly type: "pairingLinkRemoved";
      readonly id: string;
    };

export interface StoredBootstrapGrant extends BootstrapGrant {
  readonly remainingUses: number | "unbounded";
}

export type ConsumeResult =
  | {
      readonly _tag: "error";
      readonly reason: "not-found" | "expired";
      readonly error: BootstrapCredentialError;
    }
  | {
      readonly _tag: "success";
      readonly grant: BootstrapGrant;
    };
