import type { AkeruDelegationRecord, MessageId, TurnId } from "@t3tools/contracts";

/** The message fields the timeline needs to place rows. */
export interface BotChatTimelineMessage {
  readonly id: MessageId;
  readonly turnId: TurnId | null;
  readonly createdAt: string;
}

/** A timestamped row that is not a message, such as a routine receipt. */
export interface BotChatTimelineReceipt {
  readonly id: string;
  readonly createdAt: string;
}

/**
 * One row in a bot chat. `index` is the message's position in the input list,
 * so a row can find its neighbours after the merge reorders it.
 */
export type BotChatTimelineEntry<
  TMessage extends BotChatTimelineMessage = BotChatTimelineMessage,
  TReceipt extends BotChatTimelineReceipt = BotChatTimelineReceipt,
> =
  | {
      readonly _tag: "Message";
      readonly key: string;
      readonly message: TMessage;
      readonly index: number;
    }
  | { readonly _tag: "Receipt"; readonly key: string; readonly receipt: TReceipt }
  | {
      readonly _tag: "Delegation";
      readonly key: string;
      readonly delegation: AkeruDelegationRecord;
    };

export interface BotChatTimelineInput<
  TMessage extends BotChatTimelineMessage,
  TReceipt extends BotChatTimelineReceipt,
> {
  readonly messages: ReadonlyArray<TMessage>;
  readonly receipts?: ReadonlyArray<TReceipt>;
  /** Delegations this chat started, as returned by `threadDelegations`. */
  readonly delegations?: ReadonlyArray<AkeruDelegationRecord>;
}

/**
 * Orders a bot chat for web and mobile. Messages and receipts merge by time.
 * Each work card sits after the turn that started it: after its anchor message
 * and any later reply in that turn. Records without a known anchor fall back to
 * the turn's messages, then to the end of the chat.
 */
export function botChatTimeline<
  TMessage extends BotChatTimelineMessage,
  TReceipt extends BotChatTimelineReceipt = BotChatTimelineReceipt,
>(
  input: BotChatTimelineInput<TMessage, TReceipt>,
): Array<BotChatTimelineEntry<TMessage, TReceipt>> {
  type Entry = BotChatTimelineEntry<TMessage, TReceipt>;
  const base: Array<{ readonly createdAt: string; readonly entry: Entry }> = [
    ...input.messages.map((message, index) => ({
      createdAt: message.createdAt,
      entry: { _tag: "Message", key: `message:${message.id}`, message, index } as const,
    })),
    ...(input.receipts ?? []).map((receipt) => ({
      createdAt: receipt.createdAt,
      entry: { _tag: "Receipt", key: `receipt:${receipt.id}`, receipt } as const,
    })),
  ];
  const rows = base
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map(({ entry }) => entry);

  const positionByMessageId = new Map<string, number>();
  const lastPositionByTurnId = new Map<string, number>();
  rows.forEach((row, position) => {
    if (row._tag !== "Message") return;
    positionByMessageId.set(row.message.id, position);
    if (row.message.turnId !== null) lastPositionByTurnId.set(row.message.turnId, position);
  });

  // Cards inserted after the same row keep creation order.
  const cardsAfter = new Map<number, Entry[]>();
  const delegations = (input.delegations ?? []).toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.delegationId.localeCompare(right.delegationId),
  );
  for (const delegation of delegations) {
    const anchor =
      delegation.anchorMessageId === null
        ? undefined
        : positionByMessageId.get(delegation.anchorMessageId);
    const turnEnd = lastPositionByTurnId.get(delegation.parentTurnId);
    const position =
      anchor !== undefined ? Math.max(anchor, turnEnd ?? anchor) : (turnEnd ?? rows.length - 1);
    const card: Entry = {
      _tag: "Delegation",
      key: `delegation:${delegation.delegationId}`,
      delegation,
    };
    cardsAfter.set(position, [...(cardsAfter.get(position) ?? []), card]);
  }

  const leading = cardsAfter.get(-1) ?? [];
  return [
    ...leading,
    ...rows.flatMap((row, position) => [row, ...(cardsAfter.get(position) ?? [])]),
  ];
}
