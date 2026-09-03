import { CheckIcon, CopyIcon, EllipsisIcon, ReplyIcon, SmilePlusIcon } from "lucide-react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
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

export function MessageControls(props: {
  readonly copyText: string;
  readonly align?: "start" | "end";
  readonly selectedReaction?: MessageReactionOption | null;
  readonly onReply?: () => void;
  readonly onReactionChange?: (reaction: MessageReactionOption | null) => void;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "message",
    timeout: 1200,
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Failed to copy message",
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
      className={cn("flex items-center gap-0.5", props.align === "end" && "justify-end")}
      data-message-controls="true"
    >
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={
                  <Button
                    aria-label={isCopied ? "Copied" : "More message actions"}
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
          <TooltipPopup side="top">{isCopied ? "Copied" : "More"}</TooltipPopup>
        </Tooltip>
        <MenuPopup align={props.align === "end" ? "end" : "start"} side="top">
          <MenuItem onClick={() => copyToClipboard(props.copyText)}>
            <CopyIcon />
            Copy
          </MenuItem>
        </MenuPopup>
      </Menu>
      {props.onReply ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label="Reply to message"
                size="icon-xs"
                variant="ghost"
                onClick={props.onReply}
              />
            }
          >
            <ReplyIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">Reply</TooltipPopup>
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
                          ? `Change reaction, ${props.selectedReaction} selected`
                          : "React"
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
            <TooltipPopup side="top">React</TooltipPopup>
          </Tooltip>
          <MenuPopup className="min-w-0" side="top">
            <div aria-label="Choose a reaction" className="flex gap-0.5" role="group">
              {MESSAGE_REACTION_OPTIONS.map((option) => (
                <Button
                  key={option}
                  aria-label={`React ${option}`}
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
