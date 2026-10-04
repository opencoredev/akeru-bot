import React from "react";
import type { useChatMarkdownState } from "./useChatMarkdownState";

export const ChatMarkdownRendererContext = React.createContext<
  ReturnType<typeof useChatMarkdownState>["componentState"]
>(null!);
