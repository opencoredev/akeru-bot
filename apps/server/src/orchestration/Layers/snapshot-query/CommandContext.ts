import { MessageId, ThreadId } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { isPersistenceError } from "../../../persistence/Errors.ts";
import {
  type ProjectionSnapshotDependencies,
  toPersistenceSqlOrDecodeError,
  mapThreadActivityRow,
} from "../ProjectionSnapshotRows.ts";
import type { makeThreadRows } from "./ThreadRows.ts";
import type { makeThreadHistoryRows } from "./ThreadHistoryRows.ts";

export function makeCommandContext({
  sql,
  getLatestUserCommandMessage,
  listPinnedThreadActivityRowsByThread,
  commandMessageRepository,
}: Pick<
  ProjectionSnapshotDependencies &
    ReturnType<typeof makeThreadRows> &
    ReturnType<typeof makeThreadHistoryRows>,
  | "sql"
  | "getLatestUserCommandMessage"
  | "listPinnedThreadActivityRowsByThread"
  | "commandMessageRepository"
>) {
  const getThreadCommandContext = Effect.fn("ProjectionSnapshotQuery.getThreadCommandContext")(
    function* (threadId: ThreadId) {
      const [messages, activities] = yield* sql
        .withTransaction(
          Effect.all([
            getLatestUserCommandMessage({ threadId }),
            listPinnedThreadActivityRowsByThread({ threadId }),
          ]),
        )
        .pipe(
          Effect.mapError((error) =>
            isPersistenceError(error)
              ? error
              : toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThreadCommandContext:query",
                  "ProjectionSnapshotQuery.getThreadCommandContext:decode",
                )(error),
          ),
        );
      return {
        messages: messages.map((message) => ({
          id: message.messageId,
          role: "user" as const,
          text: "",
          turnId: null,
          streaming: false,
          createdAt: message.createdAt,
          updatedAt: message.updatedAt,
        })),
        activities: activities.map(mapThreadActivityRow),
      };
    },
  );

  const getCommandMessage = Effect.fn("ProjectionSnapshotQuery.getCommandMessage")(
    function* (input: { readonly threadId: ThreadId; readonly messageId: MessageId }) {
      const message = yield* commandMessageRepository.getByMessageId(input);
      return Option.flatMap(message, (row) =>
        row.threadId === input.threadId
          ? Option.some({
              id: row.messageId,
              role: row.role,
              text: row.text,
              turnId: row.turnId,
              streaming: row.isStreaming,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
              ...(row.attachments !== undefined ? { attachments: row.attachments } : {}),
              ...(row.reactions !== undefined ? { reactions: row.reactions } : {}),
            })
          : Option.none(),
      );
    },
  );
  return { getThreadCommandContext, getCommandMessage };
}
