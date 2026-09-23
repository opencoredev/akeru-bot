import { CheckIcon, CopyIcon, EllipsisIcon, ReplyIcon, SmilePlusIcon } from "lucide-react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useI18n } from "~/i18n";
import { ReplyPlaybackControls, type ReplyPlaybackControlsProps } from "./ReplyPlaybackControls";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const MESSAGE_REACTION_OPTIONS = ["👍", "👎", "❤️", "😂", "🎉", "😮"] as const;
export type MessageReactionOption = (typeof MESSAGE_REACTION_OPTIONS)[number];

export interface MessageReplyTarget {
  readonly messageId: string;
  readonly label: string;
  readonly text: string;
}

/** Narrows a stored reaction back to an offered option, so a chip from another client is ignored. */
export function reactionOptionFromEmoji(emoji: string): MessageReactionOption | null {
  return MESSAGE_REACTION_OPTIONS.find((option) => option === emoji) ?? null;
}

export function selectedReactionForPerson(
  reactions:
    | ReadonlyArray<{ readonly personId?: string | undefined; readonly emoji: string }>
    | undefined,
  personId: string | null | undefined,
): MessageReactionOption | null {
  if (!personId) return null;
  const emoji = reactions?.find((reaction) => reaction.personId === personId)?.emoji;
  return MESSAGE_REACTION_OPTIONS.find((option) => option === emoji) ?? null;
}

export function buildReplyPrompt(reply: MessageReplyTarget | null, prompt: string): string {
  if (!reply) return prompt;
  const quoted = reply.text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `> Replying to ${reply.label}\n${quoted}\n\n${prompt}`.trimEnd();
}

export interface ParsedReplyPrompt {
  readonly label: string;
  readonly quotedText: string;
  readonly body: string;
}

const REPLY_HEADER_PATTERN = /^> Replying to (\S.*)$/;
const QUOTED_LINE_PATTERN = /^>(?: (.*))?$/;

/**
 * Recovers the reply target and body from a prompt serialized by `buildReplyPrompt`,
 * so a sent reply can keep a backlink to what it answered. Only the exact shape that
 * helper emits counts: a `> Replying to <label>` header, one or more quoted lines, then
 * either the end of the text or one blank line and the body. Ordinary blockquotes return
 * null so they keep rendering as the plain text the sender wrote.
 */
export function parseReplyPrompt(text: string): ParsedReplyPrompt | null {
  const lines = text.split("\n");
  const label = REPLY_HEADER_PATTERN.exec(lines[0] ?? "")?.[1]?.trim();
  if (!label) return null;

  const quotedLines: string[] = [];
  let index = 1;
  for (; index < lines.length; index += 1) {
    const match = QUOTED_LINE_PATTERN.exec(lines[index] ?? "");
    if (!match) break;
    quotedLines.push(match[1] ?? "");
  }
  if (quotedLines.length === 0) return null;
  if (index < lines.length && lines[index] !== "") return null;

  return {
    label,
    quotedText: quotedLines.join("\n").trim(),
    body: lines.slice(index + 1).join("\n"),
  };
}

export function MessageControls(props: {
  readonly copyText: string;
  readonly align?: "start" | "end";
  readonly selectedReaction?: MessageReactionOption | null;
  readonly onReply?: () => void;
  readonly onReactionChange?: (reaction: MessageReactionOption | null) => void;
  readonly readAloud?: ReplyPlaybackControlsProps;
}) {
  const { t } = useI18n();
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "message",
    timeout: 1200,
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: t("Failed to copy message"),
        description: error.message,
      });
    },
  });
  const chooseReaction = (next: MessageReactionOption) => {
    const value = props.selectedReaction === next ? null : next;
    props.onReactionChange?.(value);
  };

  return (
    <div
      className={cn("flex flex-wrap items-center gap-0.5", props.align === "end" && "justify-end")}
      data-message-controls="true"
    >
      {props.readAloud ? <ReplyPlaybackControls {...props.readAloud} /> : null}
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={
                  <Button
                    aria-label={isCopied ? t("Copied") : t("More message actions")}
                    size="icon-xs"
                    variant="ghost"
                  />
                }
              />
            }
          >
            {isCopied ? (
              <CheckIcon className="size-3.5 text-primary" />
            ) : (
              <EllipsisIcon className="size-3.5" />
            )}
          </TooltipTrigger>
          <TooltipPopup side="top">{isCopied ? t("Copied") : t("More")}</TooltipPopup>
        </Tooltip>
        <MenuPopup align={props.align === "end" ? "end" : "start"} side="top">
          <MenuItem onClick={() => copyToClipboard(props.copyText)}>
            <CopyIcon />
            {t("Copy")}
          </MenuItem>
        </MenuPopup>
      </Menu>
      {props.onReply ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={t("Reply to message")}
                size="icon-xs"
                variant="ghost"
                onClick={props.onReply}
              />
            }
          >
            <ReplyIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">{t("Reply")}</TooltipPopup>
        </Tooltip>
      ) : null}
      {props.onReactionChange ? (
        <Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={
                    <Button
                      aria-label={
                        props.selectedReaction
                          ? t("Change reaction, {emoji} selected", {
                              emoji: props.selectedReaction,
                            })
                          : t("React")
                      }
                      size="icon-xs"
                      variant="ghost"
                    />
                  }
                />
              }
            >
              {props.selectedReaction ? (
                <span className="text-sm [font-family:'Apple_Color_Emoji','Segoe_UI_Emoji',sans-serif]">
                  {props.selectedReaction}
                </span>
              ) : (
                <SmilePlusIcon className="size-3.5" />
              )}
            </TooltipTrigger>
            <TooltipPopup side="top">{t("React")}</TooltipPopup>
          </Tooltip>
          {/* Sits clear of the message it decorates, so the picker never covers the text
              being reacted to. Picking the selected emoji again removes the reaction. */}
          <MenuPopup
            align={props.align === "end" ? "end" : "start"}
            className="min-w-0"
            side="top"
            sideOffset={8}
          >
            <div aria-label={t("Choose a reaction")} className="flex gap-0.5" role="group">
              {MESSAGE_REACTION_OPTIONS.map((option) => (
                <Button
                  key={option}
                  aria-label={
                    props.selectedReaction === option
                      ? t("Remove {emoji}", { emoji: option })
                      : t("React {emoji}", { emoji: option })
                  }
                  aria-pressed={props.selectedReaction === option}
                  className="text-base [font-family:'Apple_Color_Emoji','Segoe_UI_Emoji',sans-serif]"
                  size="icon-sm"
                  variant={props.selectedReaction === option ? "secondary" : "ghost"}
                  onClick={() => chooseReaction(option)}
                >
                  {option}
                </Button>
              ))}
            </div>
          </MenuPopup>
        </Menu>
      ) : null}
    </div>
  );
}
