import { ThreadId } from "@akeru/contracts";
import { collectComposerMentionReferences } from "@akeru/shared/composerInlineTokens";
import {
  appendComposerMentionContext,
  isHiddenComposerThread,
  THREAD_MENTION_MAX_LOOKUPS,
  THREAD_MENTION_MAX_THREADS,
  THREAD_MENTION_TURN_LIMIT,
  type ThreadMentionSource,
} from "@akeru/shared/composerThreadMentions";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { createDependencies } from "./Dependencies.ts";

export function createMentions({
  serverSettingsService,
  projectionSnapshotQuery,
}: Pick<
  Effect.Success<ReturnType<typeof createDependencies>>,
  "serverSettingsService" | "projectionSnapshotQuery"
>) {
  /**
   * Expands composer `@browser` and `@chat:<id>` mentions into a bounded
   * context block for the provider. The stored message keeps only the tokens,
   * so clients render chips and the socket never carries the excerpts.
   */
  const expandComposerMentions = Effect.fnUntraced(function* (
    threadId: ThreadId,
    messageText: string,
  ) {
    const references = collectComposerMentionReferences(messageText);

    if (!references.browser && references.threadIds.length === 0) {
      return messageText;
    }

    const browser = !references.browser
      ? null
      : (yield* serverSettingsService.getSettings.pipe(
            Effect.map((settings) => settings.enableAgentBrowserAccess),
            Effect.orElseSucceed(() => false),
          ))
        ? ("enabled" as const)
        : ("disabled" as const);

    const threads: ThreadMentionSource[] = [];

    // Hidden or missing chats do not use up a context slot, but every lookup
    // counts toward a separate cap so a prompt cannot force unbounded reads.
    const mentionedIds = references.threadIds
      .filter((id) => id !== threadId)
      .slice(0, THREAD_MENTION_MAX_LOOKUPS);

    for (const mentionedId of mentionedIds) {
      if (threads.length >= THREAD_MENTION_MAX_THREADS) break;

      const snapshot = yield* projectionSnapshotQuery
        .getThreadDetailSnapshot(ThreadId.make(mentionedId), {
          turnLimit: THREAD_MENTION_TURN_LIMIT,
        })
        .pipe(
          Effect.map(Option.getOrUndefined),
          Effect.catch((cause) =>
            Effect.logWarning("Could not read a mentioned chat for turn context.", {
              threadId,
              mentionedThreadId: mentionedId,
              cause,
            }).pipe(Effect.as(undefined)),
          ),
        );

      // Mentioned chats resolve within this environment; hidden chats are excluded.
      if (snapshot === undefined || isHiddenComposerThread(snapshot.thread)) continue;
      threads.push({
        id: snapshot.thread.id,
        title: snapshot.thread.title,
        messages: snapshot.thread.messages,
      });
    }

    return appendComposerMentionContext(messageText, { browser, threads });
  });

  return { expandComposerMentions };
}
