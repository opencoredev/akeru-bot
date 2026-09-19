import { useAtomValue } from "@effect/atom-react";
import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import type { OrchestrationMessage, ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { environmentThreadDetails } from "../../state/threads";
import { visibleBotChatMessages } from "./botConversationPresentation";

const THREAD_PROJECTION_IDLE_TTL_MS = 5 * 60_000;
const EMPTY_MESSAGES: ReadonlyArray<OrchestrationMessage> = Object.freeze([]);

export interface BotConversationMessageProjection {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly lastMessageRole: OrchestrationMessage["role"] | null;
}

const EMPTY_PROJECTION: BotConversationMessageProjection = Object.freeze({
  messages: EMPTY_MESSAGES,
  lastMessageRole: null,
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

    if (messages === previous.messages && lastMessageRole === previous.lastMessageRole) {
      return previous;
    }
    previous = { messages, lastMessageRole };
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
