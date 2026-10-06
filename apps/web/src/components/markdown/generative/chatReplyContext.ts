import { createContext } from "react";

/**
 * Lets a reply's interactive blocks send a message as the user. Bot and group chats
 * provide it; elsewhere choice cards fall back to filling the composer.
 */
export interface ChatReply {
  readonly send: (text: string) => Promise<boolean>;
  readonly disabled: boolean;
}

export const ChatReplyContext = createContext<ChatReply | null>(null);
