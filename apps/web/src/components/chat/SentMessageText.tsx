import { CornerDownRightIcon } from "lucide-react";

import { parseReplyPrompt } from "./MessageControls";

/**
 * Renders the text of a sent message. A reply serialized by `buildReplyPrompt` keeps a
 * durable backlink to what it answered: one compact quoted line above the body, instead
 * of the raw `>` markdown the provider receives.
 */
export function SentMessageText({ text }: { readonly text: string }) {
  const reply = parseReplyPrompt(text);
  if (!reply) return <p className="whitespace-pre-wrap">{text}</p>;

  return (
    <>
      <div
        className="mb-1.5 flex min-w-0 items-center gap-1.5 border-s-2 border-current/25 ps-2 text-xs opacity-70"
        data-testid="sent-reply-backlink"
      >
        <CornerDownRightIcon aria-hidden="true" className="size-3 shrink-0" />
        <span className="shrink-0 font-medium">{reply.label}</span>
        <span className="min-w-0 truncate">{reply.quotedText}</span>
      </div>
      {reply.body ? <p className="whitespace-pre-wrap">{reply.body}</p> : null}
    </>
  );
}
