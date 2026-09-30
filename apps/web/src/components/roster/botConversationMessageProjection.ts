import { useAtomValue } from "@effect/atom-react";
import { parseThreadKey, threadKey } from "@akeru/client-runtime/state/entities";
import type { OrchestrationMessage, ScopedThreadRef } from "@akeru/contracts";
import { Atom } from "effect/unstable/reactivity";

import { environmentThreadDetails } from "../../state/threads";
import { visibleBotChatMessages } from "./botConversationPresentation";

const THREAD_PROJECTION_IDLE_TTL_MS = 5 * 60_000;
const EMPTY_MESSAGES: ReadonlyArray<OrchestrationMessage> = Object.freeze([]);

export interface BotConversationMessageProjection {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly lastMessageRole: OrchestrationMessage["role"] | null;
  readonly hasMessages: boolean;
  readonly lastUserMessageAt: string | null;
}

const EMPTY_PROJECTION: BotConversationMessageProjection = Object.freeze({
  messages: EMPTY_MESSAGES,
  lastMessageRole: null,
  hasMessages: false,
  lastUserMessageAt: null,
});

const EMPTY_PROJECTION_ATOM = Atom.make(EMPTY_PROJECTION).pipe(
  Atom.withLabel("web-bot-conversation-messages:empty"),
);

function sameMessageReferences(
  left: ReadonlyArray<OrchestrationMessage>,
  right: ReadonlyArray<OrchestrationMessage>,
): boolean {
  return left.length === right.length && left.every((message, index) => message === right[index]);
}

export function createBotConversationMessageProjectionAtom(
  source: Atom.Atom<ReadonlyArray<OrchestrationMessage>>,
  label = "web-bot-conversation-messages:test",
): Atom.Atom<BotConversationMessageProjection> {
  let previous = EMPTY_PROJECTION;

  return Atom.make((get) => {
    const rawMessages = get(source);
    const nextMessages = visibleBotChatMessages(rawMessages);
    const messages = sameMessageReferences(previous.messages, nextMessages)
      ? previous.messages
      : nextMessages;
    const lastMessageRole = rawMessages.at(-1)?.role ?? null;
    const hasMessages = rawMessages.length > 0;
    const lastUserMessageAt =
      rawMessages.findLast((message) => message.role === "user")?.createdAt ?? null;

    if (
      messages === previous.messages &&
      lastMessageRole === previous.lastMessageRole &&
      hasMessages === previous.hasMessages &&
      lastUserMessageAt === previous.lastUserMessageAt
    ) {
      return previous;
    }
    previous = { messages, lastMessageRole, hasMessages, lastUserMessageAt };
    return previous;
  }).pipe(Atom.setIdleTTL(THREAD_PROJECTION_IDLE_TTL_MS), Atom.withLabel(label));
}

const botConversationMessageProjectionAtom = Atom.family((key: string) => {
  const ref = parseThreadKey(key);
  return createBotConversationMessageProjectionAtom(
    environmentThreadDetails.messagesAtom(ref),
    `web-bot-conversation-messages:${key}`,
  );
});

export function useBotConversationMessageProjection(
  ref: ScopedThreadRef | null,
): BotConversationMessageProjection {
  return useAtomValue(
    ref === null ? EMPTY_PROJECTION_ATOM : botConversationMessageProjectionAtom(threadKey(ref)),
  );
}
