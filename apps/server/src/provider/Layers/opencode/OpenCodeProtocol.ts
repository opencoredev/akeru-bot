import { readSdkRecord } from "../ProtocolJson.ts";
import { readProtocolRecord } from "../ProtocolJson.ts";
import * as Predicate from "effect/Predicate";
import {
  type ProviderSession,
  ThreadId,
  type ToolLifecycleItemType,
  type UserInputQuestion,
} from "@akeru/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import type { QuestionRequest } from "@opencode-ai/sdk/v2";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
} from "../../Errors.ts";
import {
  OpenCodeRuntimeError,
  openCodeQuestionId,
  openCodeRuntimeErrorDetail,
} from "../../opencodeRuntime.ts";

import {
  PROVIDER,
  OPENCODE_RESUME_VERSION,
  type OpenCodeSubscribedEvent,
  type OpenCodeSessionContext,
} from "./OpenCodeAdapterState.ts";

/**
 * The variant choice that leaves OpenCode on its own configured default. It is
 * namespaced so it never matches a variant name a user configured.
 */
export const OPENCODE_PROVIDER_DEFAULT_VARIANT = "akeru:provider-default";

/**
 * Decode a persisted resume cursor into the upstream `ses_…` id. Anything
 * that isn't a current-version cursor with a non-empty id means "no resume"
 * rather than an error. Re-adopting the session id IS the resume mechanism —
 * OpenCode scopes a conversation's history by session id.
 */
export function parseOpenCodeResume<Input0>(
  rawInput: Input0,
): { readonly sessionId: string } | undefined {
  const raw = rawInput;

  if (!Predicate.isObject(raw) || raw === null || Array.isArray(raw)) {
    return undefined;
  }

  const record = raw;

  if (record.schemaVersion !== OPENCODE_RESUME_VERSION) {
    return undefined;
  }

  if (!Predicate.isString(record.sessionId) || record.sessionId.trim().length === 0) {
    return undefined;
  }

  return { sessionId: record.sessionId.trim() };
}

/**
 * Whether an error definitively reports a missing session or request. Only a confirmed
 * miss may silently start a fresh session; any other failure (the SDK client
 * is `throwOnError: true`, so `session.get` rejects on every non-2xx) must
 * propagate, or a transient blip resets a live thread to an empty one — the
 * #3604 silent context loss. Decides on structured signals only, never free
 * text: a numeric 404, the exact `NotFoundError` name, or a question/permission
 * not-found tag, found via a bounded walk over `cause`/`body`/`error`/`data`.
 * An explicit non-404 status seals its
 * subtree so a wrapped "NotFound" name can't reclassify a real failure.
 * Exported for unit testing.
 */
export function isOpenCodeNotFound(cause: unknown): boolean {
  const seen = new Set<unknown>();
  const queue: Array<unknown> = [cause];

  for (let steps = 0; queue.length > 0 && steps < 32; steps += 1) {
    const node = queue.shift();

    if (node === null || !Predicate.isObject(node) || seen.has(node)) {
      continue;
    }

    seen.add(node);
    const record = node;

    const response = record.response;

    const statuses = [
      record.status,
      record.statusCode,
      response !== null && Predicate.isObject(response) ? response.status : undefined,
    ].filter((status): status is number => Predicate.isNumber(status));

    if (statuses.includes(404)) {
      return true;
    }

    if (statuses.length > 0) {
      continue;
    }

    const name = record.name;

    if (Predicate.isString(name) && name.toLowerCase() === "notfounderror") {
      return true;
    }

    if (
      Predicate.isTagged(record, "QuestionNotFoundError") ||
      Predicate.isTagged(record, "PermissionNotFoundError")
    ) {
      return true;
    }

    for (const key of ["cause", "body", "error", "data"] as const) {
      if (record[key] !== undefined) {
        queue.push(record[key]);
      }
    }
  }

  return false;
}

/**
 * Whether two directory spellings name the same location. Raw string
 * equality misreads a trailing slash, `.`/`..` segment, or symlinked cwd
 * (macOS `/tmp` → `/private/tmp`) as a cwd change, needlessly forking the
 * session on every resume. Lexically equal paths short-circuit; otherwise
 * both sides go through `realPath`, each falling back to its lexical form
 * on failure (deleted directory, external-server path) — so the probe can
 * only widen matches, never split them. Takes the services as arguments so
 * adapter methods stay service-free. Exported for unit testing.
 */
export function isSameOpenCodeDirectory(
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  left: string,
  right: string,
): Effect.Effect<boolean> {
  const lexicalLeft = path.resolve(left);
  const lexicalRight = path.resolve(right);

  if (lexicalLeft === lexicalRight) {
    return Effect.succeed(true);
  }

  const canonicalize = (lexical: string) =>
    fileSystem.realPath(lexical).pipe(Effect.orElseSucceed(() => lexical));

  return Effect.zipWith(
    canonicalize(lexicalLeft),
    canonicalize(lexicalRight),
    (canonicalLeft, canonicalRight) => canonicalLeft === canonicalRight,
  );
}

export function trimText(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();

  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function openCodeEventSessionId(event: OpenCodeSubscribedEvent): string | undefined {
  const properties = readProtocolRecord("properties" in event ? event.properties : undefined);

  if (!properties || !Predicate.isObject(properties)) {
    return undefined;
  }

  const sessionID = properties.sessionID;
  const sessionIDFromProperties = Predicate.isString(sessionID) ? sessionID : undefined;

  if (sessionIDFromProperties) {
    return sessionIDFromProperties;
  }

  const info = readProtocolRecord(properties.info);

  return info && Predicate.isString(info.id) ? info.id : undefined;
}

export function openCodeEventSessionTitle(event: OpenCodeSubscribedEvent): string | undefined {
  if (event.type !== "session.updated") {
    return undefined;
  }

  const title = trimText(event.properties.info.title);

  // OpenCode mints a placeholder title at session.create when no title was
  // provided, and re-emits it on every `session.updated`. Mirroring it would
  // overwrite the thread's real title (openCodeEventSessionTitle feeds the
  // `thread.metadata.updated` mirror). Ignore OpenCode's auto-generated
  // placeholders so the thread isn't locked onto them.
  if (!title || isOpenCodeDefaultTitle(title)) {
    return undefined;
  }

  return title;
}

export const OPENCODE_DEFAULT_TITLE_PATTERN =
  /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isOpenCodeDefaultTitle(title: string): boolean {
  return OPENCODE_DEFAULT_TITLE_PATTERN.test(title);
}

export function isOpenCodeChildRequestEvent(event: OpenCodeSubscribedEvent): boolean {
  switch (event.type) {
    case "permission.asked":
    case "permission.replied":
    case "question.asked":
    case "question.replied":
    case "question.rejected":
      return true;
    default:
      return false;
  }
}

export const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * Map a tagged OpenCodeRuntimeError produced by {@link runOpenCodeSdk} into
 * the adapter-boundary `ProviderAdapterRequestError`. SDK-method-level call
 * sites pipe through this in `Effect.mapError` so they never build the error
 * shape by hand.
 */
export const toRequestError = (cause: OpenCodeRuntimeError): ProviderAdapterRequestError =>
  new ProviderAdapterRequestError({
    provider: PROVIDER,
    method: cause.operation,
    detail: cause.detail,
    cause: cause.cause,
  });

/**
 * Map a `Cause.squash`-ed failure into a `ProviderAdapterProcessError`. The
 * typed cause is usually an `OpenCodeRuntimeError` (from {@link runOpenCodeSdk}),
 * in which case we preserve its `detail`; otherwise we fall back to
 * {@link openCodeRuntimeErrorDetail} for unknown causes (defects, etc.).
 */
export const toProcessError = (threadId: ThreadId, cause: unknown): ProviderAdapterProcessError =>
  new ProviderAdapterProcessError({
    provider: PROVIDER,
    threadId,
    detail: OpenCodeRuntimeError.is(cause) ? cause.detail : openCodeRuntimeErrorDetail(cause),
    cause,
  });

export function toToolLifecycleItemType(toolName: string): ToolLifecycleItemType {
  const normalized = toolName.toLowerCase();

  if (normalized.includes("bash") || normalized.includes("command")) {
    return "command_execution";
  }

  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("patch") ||
    normalized.includes("multiedit")
  ) {
    return "file_change";
  }

  if (normalized.includes("web")) {
    return "web_search";
  }

  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }

  if (normalized.includes("image")) {
    return "image_view";
  }

  if (
    normalized.includes("task") ||
    normalized.includes("agent") ||
    normalized.includes("subtask")
  ) {
    return "collab_agent_tool_call";
  }

  return "dynamic_tool_call";
}

export function mapPermissionToRequestType(
  permission: string,
): "command_execution_approval" | "file_read_approval" | "file_change_approval" | "unknown" {
  switch (permission) {
    case "bash":
      return "command_execution_approval";
    case "read":
      return "file_read_approval";
    case "edit":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

export function mapPermissionDecision(reply: "once" | "always" | "reject"): string {
  switch (reply) {
    case "once":
      return "accept";
    case "always":
      return "acceptForSession";
    case "reject":
    default:
      return "decline";
  }
}

export const ensureSessionContext = Effect.fn("ensureSessionContext")(function* (
  sessions: ReadonlyMap<ThreadId, OpenCodeSessionContext>,
  threadId: ThreadId,
) {
  const session = sessions.get(threadId);

  if (!session) {
    return yield* new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
    });
  }

  if (yield* Ref.get(session.stopped)) {
    return yield* new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
    });
  }

  return session;
});

export function normalizeQuestionRequest(
  request: QuestionRequest,
): ReadonlyArray<UserInputQuestion> {
  return request.questions.map((question, index) => ({
    id: openCodeQuestionId(index, question),
    header: question.header,
    question: question.question,
    options: question.options.map((option) => ({
      label: option.label,
      description: option.description,
    })),
    ...(question.multiple ? { multiSelect: true } : {}),
  }));
}

export function sessionErrorMessage<Input0>(errorInput: Input0): string {
  const error = readSdkRecord(errorInput);

  if (!error || !Predicate.isObject(error)) {
    return "OpenCode session failed.";
  }

  const data = error.data && Predicate.isObject(error.data) ? error.data : null;

  const message = data && "message" in data ? data.message : null;

  return Predicate.isString(message) && message.trim().length > 0
    ? message
    : "OpenCode session failed.";
}

export function updateProviderSession(
  context: OpenCodeSessionContext,
  patch: Partial<ProviderSession>,
  options?: {
    readonly clearActiveTurnId?: boolean;
    readonly clearLastError?: boolean;
  },
): Effect.Effect<ProviderSession> {
  return Effect.gen(function* () {
    const updatedAt = yield* nowIso;

    const nextSession = {
      ...context.session,
      ...patch,
      updatedAt,
    };

    const mutableSession = nextSession;

    if (options?.clearActiveTurnId) {
      delete mutableSession.activeTurnId;
    }

    if (options?.clearLastError) {
      delete mutableSession.lastError;
    }

    context.session = nextSession;

    return nextSession;
  });
}
