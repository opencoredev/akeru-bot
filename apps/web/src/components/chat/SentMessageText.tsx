import type { ServerProviderSkill } from "@t3tools/contracts";
import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";
import { AtSignIcon, GlobeIcon, MessageSquareIcon } from "lucide-react";
import { type ReactNode, useMemo } from "react";

import { useI18n } from "../../i18n";
import { useThreadShells } from "../../state/entities";
import {
  CHAT_INLINE_CHIP_CLASS_NAME,
  CHAT_INLINE_CHIP_LABEL_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
} from "../composerInlineChip";
import { useRosterStore } from "../roster/rosterStore";
import { parseReplyPrompt } from "./MessageControls";
import { ReplyReference } from "./ReplyReference";
import { SkillInlineText } from "./SkillInlineText";

/**
 * Renders the text of a sent message. A reply serialized by `buildReplyPrompt` keeps a
 * durable backlink to what it answered: one compact quoted line above the body, instead
 * of the raw `>` markdown the provider receives. `$name` tokens that match `skills` render
 * as skill chips, like the classic chat.
 */
export function SentMessageText({
  text,
  skills = NO_SKILLS,
  replySourceMessageId = null,
}: {
  readonly text: string;
  readonly skills?: ReadonlyArray<ServerProviderSkill> | undefined;
  /** The answered message, when it is on screen, so the backlink can jump to it. */
  readonly replySourceMessageId?: string | null;
}) {
  const reply = parseReplyPrompt(text);
  if (!reply) {
    return (
      <p className="whitespace-pre-wrap">
        <MentionText text={text} skills={skills} />
      </p>
    );
  }

  return (
    <>
      <div className="mb-1.5" data-testid="sent-reply-backlink">
        <ReplyReference
          label={reply.label}
          text={reply.quotedText}
          sourceMessageId={replySourceMessageId}
        />
      </div>
      {reply.body ? (
        <p className="whitespace-pre-wrap">
          <MentionText text={reply.body} skills={skills} />
        </p>
      ) : null}
    </>
  );
}

const NO_SKILLS: ReadonlyArray<ServerProviderSkill> = [];

/** Shows `@browser`, `@chat:<id>`, `@bot:<id>`, and known `$skill` tokens as chips; copying still yields the raw token. */
function MentionText({
  text,
  skills,
}: {
  readonly text: string;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}) {
  const { t } = useI18n();
  const plain = (segment: string, key: number) =>
    skills.length === 0 ? segment : <SkillInlineText key={key} text={segment} skills={skills} />;
  const tokens = collectComposerInlineTokens(`${text}\n`).filter(
    (token) =>
      token.type === "browser-mention" ||
      token.type === "thread-mention" ||
      token.type === "bot-mention",
  );
  if (tokens.length === 0) return plain(text, 0);
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const token of tokens) {
    if (token.start > cursor) nodes.push(plain(text.slice(cursor, token.start), -token.start - 1));
    nodes.push(
      token.type === "browser-mention" ? (
        <MentionChip key={token.start} source={token.source} label={t("Browser")} icon="browser" />
      ) : token.type === "bot-mention" ? (
        <BotMentionChip key={token.start} source={token.source} botId={token.value} />
      ) : (
        <ThreadMentionChip key={token.start} source={token.source} threadId={token.value} />
      ),
    );
    cursor = token.end;
  }
  if (cursor < text.length) nodes.push(plain(text.slice(cursor), -text.length - 2));
  return nodes;
}

function ThreadMentionChip({ source, threadId }: { source: string; threadId: string }) {
  const { t } = useI18n();
  const shells = useThreadShells();
  const title = useMemo(
    () => shells.find((shell) => shell.id === threadId)?.title ?? null,
    [shells, threadId],
  );
  return <MentionChip source={source} label={title ?? t("Unknown chat")} icon="thread" />;
}

function BotMentionChip({ source, botId }: { source: string; botId: string }) {
  const { t } = useI18n();
  const name = useRosterStore((state) => state.bots.find((bot) => bot.id === botId)?.name ?? null);
  return <MentionChip source={source} label={name ?? t("Unknown bot")} icon="bot" />;
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
