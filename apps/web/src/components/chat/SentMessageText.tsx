import {
  BROWSER_MENTION_LABEL,
  collectComposerInlineTokens,
  UNKNOWN_BOT_MENTION_LABEL,
  UNKNOWN_CHAT_MENTION_LABEL,
} from "@t3tools/shared/composerInlineTokens";
import { AtSignIcon, CornerDownRightIcon, GlobeIcon, MessageSquareIcon } from "lucide-react";
import { type ReactNode, useMemo } from "react";

import { useThreadShells } from "../../state/entities";
import {
  CHAT_INLINE_CHIP_CLASS_NAME,
  CHAT_INLINE_CHIP_LABEL_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
} from "../composerInlineChip";
import { useRosterStore } from "../roster/rosterStore";
import { parseReplyPrompt } from "./MessageControls";

/**
 * Renders the text of a sent message. A reply serialized by `buildReplyPrompt` keeps a
 * durable backlink to what it answered: one compact quoted line above the body, instead
 * of the raw `>` markdown the provider receives.
 */
export function SentMessageText({ text }: { readonly text: string }) {
  const reply = parseReplyPrompt(text);
  if (!reply) {
    return (
      <p className="whitespace-pre-wrap">
        <MentionText text={text} />
      </p>
    );
  }

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
      {reply.body ? (
        <p className="whitespace-pre-wrap">
          <MentionText text={reply.body} />
        </p>
      ) : null}
    </>
  );
}

/** Shows `@browser`, `@chat:<id>`, and `@bot:<id>` as chips; copying still yields the raw token. */
function MentionText({ text }: { readonly text: string }) {
  const tokens = collectComposerInlineTokens(`${text}\n`).filter(
    (token) =>
      token.type === "browser-mention" ||
      token.type === "thread-mention" ||
      token.type === "bot-mention",
  );
  if (tokens.length === 0) return text;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const token of tokens) {
    if (token.start > cursor) nodes.push(text.slice(cursor, token.start));
    nodes.push(
      token.type === "browser-mention" ? (
        <MentionChip
          key={token.start}
          source={token.source}
          label={BROWSER_MENTION_LABEL}
          icon="browser"
        />
      ) : token.type === "bot-mention" ? (
        <BotMentionChip key={token.start} source={token.source} botId={token.value} />
      ) : (
        <ThreadMentionChip key={token.start} source={token.source} threadId={token.value} />
      ),
    );
    cursor = token.end;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function ThreadMentionChip({ source, threadId }: { source: string; threadId: string }) {
  const shells = useThreadShells();
  const title = useMemo(
    () => shells.find((shell) => shell.id === threadId)?.title ?? UNKNOWN_CHAT_MENTION_LABEL,
    [shells, threadId],
  );
  return <MentionChip source={source} label={title} icon="thread" />;
}

function BotMentionChip({ source, botId }: { source: string; botId: string }) {
  const name = useRosterStore(
    (state) => state.bots.find((bot) => bot.id === botId)?.name ?? UNKNOWN_BOT_MENTION_LABEL,
  );
  return <MentionChip source={source} label={name} icon="bot" />;
}

const MENTION_CHIP_ICONS = { browser: GlobeIcon, thread: MessageSquareIcon, bot: AtSignIcon };

function MentionChip(props: { source: string; label: string; icon: "browser" | "thread" | "bot" }) {
  const Icon = MENTION_CHIP_ICONS[props.icon];
  return (
    <span className="inline-flex align-middle leading-none" data-markdown-copy={props.source}>
      <span className={CHAT_INLINE_CHIP_CLASS_NAME}>
        <Icon aria-hidden="true" className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME} />
        <span className={CHAT_INLINE_CHIP_LABEL_CLASS_NAME}>{props.label}</span>
      </span>
    </span>
  );
}
