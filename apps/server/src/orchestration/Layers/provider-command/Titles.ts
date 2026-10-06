import * as Data from "effect/Data";
import { CommandId, PLACEHOLDER_THREAD_TITLE, ThreadId } from "@akeru/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { makeDrainableWorker } from "@akeru/shared/DrainableWorker";
import { resolveThreadWorkspaceCwd } from "../../../checkpointing/Utils.ts";
import { DEFAULT_THREAD_TITLE } from "../../threadTitles.ts";
import { type ProviderIntentEvent } from "./Fields.ts";
import { formatThreadTitleContext } from "./TitleContext.ts";
import type { createContext } from "./Context.ts";
import type { createWorkspace } from "./Workspace.ts";
import type { createDependencies } from "./Dependencies.ts";

const TitleRegeneration = Data.taggedEnum<
  | { readonly _tag: "Superseded" }
  | { readonly _tag: "Completed"; readonly title: string | undefined }
>();

export const createTitles = Effect.fn("makeprovider-command-Titles")(function* ({
  resolveProject,
  serverSettingsService,
  textGeneration,
  resolveThreadShell,
  orchestrationEngine,
  serverCommandId,
  projectionSnapshotQuery,
}: Pick<
  ReturnType<typeof createContext> &
    ReturnType<typeof createWorkspace> &
    Effect.Success<ReturnType<typeof createDependencies>>,
  | "resolveProject"
  | "serverSettingsService"
  | "textGeneration"
  | "resolveThreadShell"
  | "orchestrationEngine"
  | "serverCommandId"
  | "projectionSnapshotQuery"
>) {
  const regenerateThreadTitle = Effect.fn("regenerateThreadTitle")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>,
    requestId: CommandId,
  ) {
    if (event.payload.regenerateTitle !== true) {
      return TitleRegeneration.Superseded();
    }

    const thread = Option.getOrUndefined(
      yield* projectionSnapshotQuery.getThreadDetailById(event.payload.threadId, {
        activityKinds: [],
        pinOldestUserMessage: true,
      }),
    );

    if (!thread || thread.titleRegeneration?.requestId !== requestId) {
      return TitleRegeneration.Superseded();
    }

    const { message, attachments } = formatThreadTitleContext(thread.messages);

    if (message.length === 0) {
      return TitleRegeneration.Completed({ title: undefined });
    }

    const previousTitle = event.payload.previousTitle ?? thread.title;

    if (thread.title !== previousTitle) {
      return TitleRegeneration.Superseded();
    }

    const project = yield* resolveProject(thread.projectId);

    const cwd =
      resolveThreadWorkspaceCwd({
        thread,
        projects: project ? [project] : [],
      }) ?? process.cwd();

    const { textGenerationModelSelection: modelSelection } =
      yield* serverSettingsService.getSettings;

    const generated = yield* textGeneration.generateThreadTitle({
      cwd,
      message,
      previousTitle,
      ...(attachments.length > 0 ? { attachments } : {}),
      modelSelection,
    });

    if (
      generated.title === DEFAULT_THREAD_TITLE ||
      generated.title === PLACEHOLDER_THREAD_TITLE ||
      generated.title === previousTitle
    ) {
      return TitleRegeneration.Completed({ title: undefined });
    }

    const latestThread = yield* resolveThreadShell(event.payload.threadId);

    if (
      !latestThread ||
      latestThread.titleRegeneration?.requestId !== requestId ||
      latestThread.title !== previousTitle
    ) {
      return TitleRegeneration.Superseded();
    }

    return TitleRegeneration.Completed({ title: generated.title });
  });

  const dispatchThreadTitleRegenerationCompletion = Effect.fn(
    "dispatchThreadTitleRegenerationCompletion",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly requestId: CommandId;
    readonly title?: string;
  }) {
    yield* orchestrationEngine.dispatch({
      type: "thread.title.regeneration.complete",
      commandId: yield* serverCommandId("thread-title-regeneration-complete"),
      threadId: input.threadId,
      requestId: input.requestId,
      ...(input.title !== undefined ? { title: input.title } : {}),
    });
  });

  const findInterruptedThreadTitleRegenerations = Effect.fn(
    "findInterruptedThreadTitleRegenerations",
  )(function* () {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();

    return readModel.threads.flatMap((thread) => {
      const requestId = thread.titleRegeneration?.requestId;

      return requestId === undefined ? [] : [{ threadId: thread.id, requestId }];
    });
  });

  const clearInterruptedThreadTitleRegenerations = Effect.fn(
    "clearInterruptedThreadTitleRegenerations",
  )(function* (
    interrupted: ReadonlyArray<{ readonly threadId: ThreadId; readonly requestId: CommandId }>,
  ) {
    yield* Effect.forEach(
      interrupted,
      ({ threadId, requestId }) => {
        return dispatchThreadTitleRegenerationCompletion({
          threadId,
          requestId,
        }).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) {
              return Effect.interrupt;
            }

            return Effect.logWarning(
              "provider command reactor failed to clear interrupted title regeneration",
              {
                threadId,
                cause: Cause.pretty(cause),
              },
            );
          }),
        );
      },
      { discard: true },
    );
  });

  const processThreadTitleRegenerationSafely = Effect.fn("processThreadTitleRegenerationSafely")(
    function* (event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>) {
      if (event.payload.regenerateTitle !== true) {
        return;
      }

      const requestId = event.payload.titleRegeneration?.requestId ?? event.commandId;

      if (requestId === null) {
        return;
      }

      const result = yield* regenerateThreadTitle(event, requestId).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }

          return Effect.logWarning("provider command reactor failed to regenerate thread title", {
            threadId: event.payload.threadId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(TitleRegeneration.Completed({ title: undefined })));
        }),
      );

      if (TitleRegeneration.$is("Superseded")(result)) {
        return;
      }

      const completion = {
        threadId: event.payload.threadId,
        requestId,
        ...(result.title !== undefined ? { title: result.title } : {}),
      };

      yield* dispatchThreadTitleRegenerationCompletion(completion).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }

          return Effect.logWarning(
            "provider command reactor retrying title regeneration completion",
            {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            },
          ).pipe(Effect.andThen(dispatchThreadTitleRegenerationCompletion(completion)));
        }),
      );
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }

          return Effect.logWarning(
            "provider command reactor failed to complete title regeneration",
            {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            },
          );
        }),
      ),
  );

  const threadTitleRegenerationWorker = yield* makeDrainableWorker(
    processThreadTitleRegenerationSafely,
  );

  return {
    regenerateThreadTitle,
    dispatchThreadTitleRegenerationCompletion,
    findInterruptedThreadTitleRegenerations,
    clearInterruptedThreadTitleRegenerations,
    processThreadTitleRegenerationSafely,
    threadTitleRegenerationWorker,
  };
});
