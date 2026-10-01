import { ThreadId } from "@akeru/contracts";
import * as Schema from "effect/Schema";
import * as CodexErrors from "effect-codex-app-server/errors";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  type ProviderAdapterError,
} from "../../Errors.ts";
import { CodexResumeCursorSchema } from "./CodexRuntimeRequests.ts";
import {
  CodexSessionRuntimeThreadIdMissingError,
  type CodexSessionRuntimeError,
} from "./CodexRuntimeErrors.ts";

import { PROVIDER } from "./CodexAdapterState.ts";

export const isCodexAppServerProcessExitedError = Schema.is(
  CodexErrors.CodexAppServerProcessExitedError,
);

export const isCodexAppServerTransportError = Schema.is(CodexErrors.CodexAppServerTransportError);

export const isCodexSessionRuntimeThreadIdMissingError = Schema.is(
  CodexSessionRuntimeThreadIdMissingError,
);

export const isCodexResumeCursorSchema = Schema.is(CodexResumeCursorSchema);

export function mapCodexRuntimeError(
  threadId: ThreadId,
  method: string,
  error: CodexSessionRuntimeError,
): ProviderAdapterError {
  if (isCodexAppServerProcessExitedError(error) || isCodexAppServerTransportError(error)) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause: error,
    });
  }

  if (isCodexSessionRuntimeThreadIdMissingError(error)) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause: error,
    });
  }

  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: error.message,
    cause: error,
  });
}

export const FATAL_CODEX_STDERR_SNIPPETS = ["failed to connect to websocket"];

export function isFatalCodexProcessStderrMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return FATAL_CODEX_STDERR_SNIPPETS.some((snippet) => normalized.includes(snippet));
}
