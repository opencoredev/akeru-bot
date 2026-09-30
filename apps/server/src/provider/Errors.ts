import * as Schema from "effect/Schema";

import type { CheckpointServiceError } from "../checkpointing/Errors.ts";

/**
 * ProviderAdapterValidationError - Invalid adapter API input.
 */
export class ProviderAdapterValidationError extends Schema.TaggedErrorClass<ProviderAdapterValidationError>()(
  "ProviderAdapterValidationError",
  {
    provider: Schema.String,
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider adapter validation failed (${this.provider}) in ${this.operation}: ${this.issue}`;
  }
}

/**
 * ProviderAdapterSessionNotFoundError - Adapter-owned session id is unknown.
 */
export class ProviderAdapterSessionNotFoundError extends Schema.TaggedErrorClass<ProviderAdapterSessionNotFoundError>()(
  "ProviderAdapterSessionNotFoundError",
  {
    provider: Schema.String,
    threadId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Unknown ${this.provider} adapter thread: ${this.threadId}`;
  }
}

/**
 * ProviderAdapterSessionClosedError - Adapter session exists but is closed.
 */
export class ProviderAdapterSessionClosedError extends Schema.TaggedErrorClass<ProviderAdapterSessionClosedError>()(
  "ProviderAdapterSessionClosedError",
  {
    provider: Schema.String,
    threadId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `${this.provider} adapter thread is closed: ${this.threadId}`;
  }
}

/**
 * ProviderAdapterRequestError - Provider protocol request failed or timed out.
 */
export class ProviderAdapterRequestError extends Schema.TaggedErrorClass<ProviderAdapterRequestError>()(
  "ProviderAdapterRequestError",
  {
    provider: Schema.String,
    method: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    // True when the request is still pending after the failure and can be sent again.
    retryable: Schema.optional(Schema.Boolean),
  },
) {
  override get message(): string {
    return `Provider adapter request failed (${this.provider}) for ${this.method}: ${this.detail}`;
  }
}

/**
 * ProviderAdapterProcessError - Provider process lifecycle failure.
 */
export class ProviderAdapterProcessError extends Schema.TaggedErrorClass<ProviderAdapterProcessError>()(
  "ProviderAdapterProcessError",
  {
    provider: Schema.String,
    threadId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider adapter process error (${this.provider}) for thread ${this.threadId}: ${this.detail}`;
  }
}

/**
 * ProviderValidationError - Invalid provider API input.
 */
export class ProviderValidationError extends Schema.TaggedErrorClass<ProviderValidationError>()(
  "ProviderValidationError",
  {
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider validation failed in ${this.operation}: ${this.issue}`;
  }
}

/**
 * ProviderUnsupportedError - Requested provider is not implemented.
 */
export class ProviderUnsupportedError extends Schema.TaggedErrorClass<ProviderUnsupportedError>()(
  "ProviderUnsupportedError",
  {
    provider: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider '${this.provider}' is not implemented`;
  }
}

/**
 * ProviderInstanceNotFoundError - Lookup against the instance registry failed.
 *
 * Distinct from `ProviderUnsupportedError`: the driver is registered, but no
 * instance with the requested id has been bootstrapped — typically because
 * the persisted instance id refers to an instance the user removed from
 * settings, or because routing is asked for an instance before the registry
 * has finished its first reload.
 */
export class ProviderInstanceNotFoundError extends Schema.TaggedErrorClass<ProviderInstanceNotFoundError>()(
  "ProviderInstanceNotFoundError",
  {
    instanceId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `No provider instance bound to id '${this.instanceId}'`;
  }
}

/**
 * ProviderDriverError - A driver `create` call failed before producing an
 * instance. Surfaced to the registry, which marks the offending entry as
 * an "unavailable" shadow snapshot rather than crashing the server.
 */
export class ProviderDriverError extends Schema.TaggedErrorClass<ProviderDriverError>()(
  "ProviderDriverError",
  {
    driver: Schema.String,
    instanceId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider driver '${this.driver}' failed to create instance '${this.instanceId}': ${this.detail}`;
  }
}

/**
 * ProviderSessionNotFoundError - Provider-facing session not found.
 */
export class ProviderSessionNotFoundError extends Schema.TaggedErrorClass<ProviderSessionNotFoundError>()(
  "ProviderSessionNotFoundError",
  {
    threadId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Unknown provider thread: ${this.threadId}`;
  }
}

/**
 * ProviderSessionDirectoryPersistenceError - Session directory persistence failure.
 */
export class ProviderSessionDirectoryPersistenceError extends Schema.TaggedErrorClass<ProviderSessionDirectoryPersistenceError>()(
  "ProviderSessionDirectoryPersistenceError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider session directory persistence error in ${this.operation}: ${this.detail}`;
  }
}

export class AgentControllerUnsupportedEngineError extends Schema.TaggedErrorClass<AgentControllerUnsupportedEngineError>()(
  "AgentControllerUnsupportedEngineError",
  {
    provider: Schema.String,
    model: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `AgentController cannot resolve engine '${this.provider}/${this.model}': ${this.detail}`;
  }
}

export class AgentControllerRuntimeError extends Schema.TaggedErrorClass<AgentControllerRuntimeError>()(
  "AgentControllerRuntimeError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    // True when the request is still pending after the failure and can be sent again.
    retryable: Schema.optional(Schema.Boolean),
  },
) {
  override get message(): string {
    return `AgentController failed in ${this.operation}: ${this.detail}`;
  }
}

/**
 * The session's runtime cannot rewind its own conversation. Mastra-backed
 * sessions raise this from `rollbackConversation`; checkpoint revert treats it
 * as expected and still completes the workspace revert.
 */
export class AgentControllerRollbackUnsupportedError extends Schema.TaggedErrorClass<AgentControllerRollbackUnsupportedError>()(
  "AgentControllerRollbackUnsupportedError",
  {
    threadId: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `AgentController cannot roll back thread '${this.threadId}': ${this.detail}`;
  }
}

export type ProviderAdapterError =
  | ProviderAdapterValidationError
  | ProviderAdapterSessionNotFoundError
  | ProviderAdapterSessionClosedError
  | ProviderAdapterRequestError
  | ProviderAdapterProcessError;

export type ProviderServiceError =
  | ProviderValidationError
  | ProviderUnsupportedError
  | ProviderInstanceNotFoundError
  | ProviderSessionNotFoundError
  | ProviderSessionDirectoryPersistenceError
  | ProviderAdapterError
  | CheckpointServiceError;

export type AgentControllerError =
  | AgentControllerUnsupportedEngineError
  | AgentControllerRuntimeError
  | AgentControllerRollbackUnsupportedError
  | ProviderServiceError;

const hasReadableIssue = Schema.is(
  Schema.Union([ProviderValidationError, ProviderAdapterValidationError]),
);
const hasReadableDetail = Schema.is(
  Schema.Union([
    ProviderAdapterRequestError,
    ProviderAdapterProcessError,
    ProviderDriverError,
    ProviderSessionDirectoryPersistenceError,
    AgentControllerUnsupportedEngineError,
    AgentControllerRuntimeError,
    AgentControllerRollbackUnsupportedError,
  ]),
);

/**
 * The part of a provider or controller error a user can act on. Drops the
 * class name, operation prefix, and stack so chats and bot work cards never
 * show server paths. Log the full cause separately.
 */
export function readableErrorDetail(error: unknown): string {
  if (hasReadableIssue(error)) return error.issue;
  if (hasReadableDetail(error)) return error.detail;
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
  const firstLine = message
    ?.split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("at "));
  return firstLine ?? "Something went wrong.";
}
