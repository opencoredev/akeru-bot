import { ReplyIcon } from "lucide-react";
import { useState } from "react";

import { useI18n } from "~/i18n";

import { parseReplyPrompt } from "./MessageControls";

export function ReplyReference({
  label,
  text,
  compact = false,
  sourceMessageId,
}: {
  readonly label: string;
  readonly text: string;
  readonly compact?: boolean;
  readonly sourceMessageId?: string | null;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const longQuote = text.length > 120 || text.split("\n").length > 2;

  const jumpToSource = () => {
    if (!sourceMessageId) return;
    const source = document.getElementById(`chat-message-${sourceMessageId}`);
    source?.scrollIntoView({ behavior: "smooth", block: "center" });
    source?.focus({ preventScroll: true });
  };

  return (
    <div className={compact ? "min-w-0" : "min-w-0 text-left"} data-testid="reply-reference">
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <ReplyIcon aria-hidden className="size-3.5 shrink-0" />
        {sourceMessageId ? (
          <button
            type="button"
            className="max-w-28 shrink-0 truncate font-semibold text-foreground underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            aria-label={t("Jump to original message from {name}", { name: label })}
            onClick={jumpToSource}
          >
            {label}
          </button>
        ) : (
          <span className="max-w-28 shrink-0 truncate font-semibold text-foreground">{label}</span>
        )}
        <span aria-hidden="true">·</span>
        <span className="min-w-0 flex-1 truncate">{text.replace(/\s+/g, " ")}</span>
      </div>
      {expanded ? (
        <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">
          {text}
        </p>
      ) : null}
      {longQuote ? (
        <button
          type="button"
          className="mt-1 text-xs font-medium text-foreground/70 underline-offset-2 hover:text-foreground hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t("Show less") : t("Show full message")}
        </button>
      ) : null}
    </div>
  );
}

export function ReplyMessageBody({
  text,
  sourceMessageId,
}: {
  readonly text: string;
  readonly sourceMessageId?: string | null;
}) {
  const reply = parseReplyPrompt(text);
  if (!reply) return <p className="whitespace-pre-wrap">{text}</p>;
  return (
    <div className="space-y-2">
      <ReplyReference
        label={reply.label}
        text={reply.quotedText}
        sourceMessageId={sourceMessageId ?? null}
      />
      <p className="whitespace-pre-wrap">{reply.body}</p>
    </div>
  );
}
