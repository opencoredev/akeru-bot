import { type ProviderSession, RuntimeMode, ThreadId } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";

import { isCodexResumeCursorSchema, buildThreadStartParams } from "./CodexRuntimeRequests.ts";
import { type CodexServiceTier } from "./CodexRuntimeState.ts";

export const ANSI_ESCAPE_CHAR = String.fromCharCode(27);

export const ANSI_ESCAPE_REGEX = new RegExp(`${ANSI_ESCAPE_CHAR}\\[[0-9;]*m`, "g");

export const CODEX_STDERR_LOG_REGEX =
  /^\d{4}-\d{2}-\d{2}T\S+\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+\S+:\s+(.*)$/;

export const BENIGN_ERROR_LOG_SNIPPETS = [
  "state db missing rollout path for thread",
  "state db record_discrepancy: find_thread_path_by_id_str_in_subdir, falling_back",
];

export const CODEX_APP_SERVER_FORCE_KILL_AFTER = "2 seconds" as const;

export const RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS = [
  "not found",
  "missing thread",
  "no such thread",
  "unknown thread",
  "does not exist",
  "no rollout found",
];

export function readResumeCursorThreadId(
  resumeCursor: ProviderSession["resumeCursor"],
): string | undefined {
  return isCodexResumeCursorSchema(resumeCursor) ? resumeCursor.threadId : undefined;
}

export function classifyCodexStderrLine(rawLine: string): { readonly message: string } | null {
  const line = rawLine.replaceAll(ANSI_ESCAPE_REGEX, "").trim();

  if (!line) {
    return null;
  }

  const match = line.match(CODEX_STDERR_LOG_REGEX);

  if (match) {
    const level = match[1];

    if (level && level !== "ERROR") {
      return null;
    }

    if (BENIGN_ERROR_LOG_SNIPPETS.some((snippet) => line.includes(snippet))) {
      return null;
    }
  }

  return { message: line };
}

export function isRecoverableThreadResumeError(cause: unknown): boolean {
  const error = cause;

  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();

  if (!message.includes("thread")) {
    return false;
  }

  return RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS.some((snippet) => message.includes(snippet));
}

export type CodexThreadOpenResponse =
  | CodexRpc.ClientRequestResponsesByMethod["thread/start"]
  | CodexRpc.ClientRequestResponsesByMethod["thread/resume"];

export type CodexThreadOpenMethod = "thread/start" | "thread/resume";

export interface CodexThreadOpenClient {
  readonly request: <M extends CodexThreadOpenMethod>(
    method: M,
    payload: CodexRpc.ClientRequestParamsByMethod[M],
  ) => Effect.Effect<CodexRpc.ClientRequestResponsesByMethod[M], CodexErrors.CodexAppServerError>;
}

export const openCodexThread = (input: {
  readonly client: CodexThreadOpenClient;
  readonly threadId: ThreadId;
  readonly runtimeMode: RuntimeMode;
  readonly cwd: string;
  readonly requestedModel: string | undefined;
  readonly serviceTier: CodexServiceTier | undefined;
  readonly resumeThreadId: string | undefined;
}): Effect.Effect<CodexThreadOpenResponse, CodexErrors.CodexAppServerError> => {
  const resumeThreadId = input.resumeThreadId;

  const startParams = buildThreadStartParams({
    cwd: input.cwd,
    runtimeMode: input.runtimeMode,
    model: input.requestedModel,
    serviceTier: input.serviceTier,
  });

  if (resumeThreadId === undefined) {
    return input.client.request("thread/start", startParams);
  }

  return input.client
    .request("thread/resume", {
      threadId: resumeThreadId,
      ...startParams,
    })
    .pipe(
      Effect.catchIf(isRecoverableThreadResumeError, (error) =>
        Effect.logWarning("codex app-server thread resume fell back to fresh start", {
          threadId: input.threadId,
          requestedRuntimeMode: input.runtimeMode,
          resumeThreadId,
          recoverable: true,
          cause: error,
        }).pipe(Effect.andThen(input.client.request("thread/start", startParams))),
      ),
    );
};
