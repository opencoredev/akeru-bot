import { use, useState } from "react";
import { useComposerDraftStore } from "../../../composerDraftStore";
import { useI18n } from "../../../i18n";
import { Badge } from "../../ui/badge";
import { ChatMarkdownRendererContext } from "../MarkdownRendererContext";
import { ChatReplyContext } from "./chatReplyContext";
import type { ChoicesSpec } from "./generativeSchemas";
import { GenerativeFrame } from "./GenerativeFrame";

/**
 * Option cards. In bot and group chats a click sends the option's reply right away;
 * elsewhere it drafts the reply in the composer.
 */
export function GenerativeChoices({ spec }: { readonly spec: ChoicesSpec }) {
  const { t } = useI18n();
  const { threadRef } = use(ChatMarkdownRendererContext);
  const reply = use(ChatReplyContext);
  const [selected, setSelected] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const answered = reply !== null && selected !== null && !sending;

  const choose = async (option: ChoicesSpec["options"][number]) => {
    if (!reply) {
      setSelected(option.label);

      if (threadRef) useComposerDraftStore.getState().setPrompt(threadRef, option.reply);

      return;
    }

    setSelected(option.label);
    setSending(true);
    const sent = await reply.send(option.reply);
    setSending(false);

    if (!sent) setSelected(null);
  };

  const locked = reply !== null && (reply.disabled || sending || answered);

  return (
    <GenerativeFrame kind="choices" title={spec.question}>
      <div
        className="gen-choices flex flex-col gap-2"
        data-answered={selected !== null}
        data-unavailable={locked && selected === null}
      >
        {spec.options.map((option) => (
          <button
            key={option.label}
            type="button"
            className="gen-choice flex w-full items-start justify-between gap-3 rounded-xl border border-border bg-background px-3 py-2.5 text-left transition-colors enabled:hover:bg-accent disabled:cursor-default"
            aria-pressed={selected === option.label}
            disabled={locked}
            onClick={() => void choose(option)}
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-medium text-foreground">{option.label}</span>
              {option.detail ? (
                <span className="text-xs text-muted-foreground">{option.detail}</span>
              ) : null}
            </span>
            {option.recommended ? (
              <Badge variant="secondary" className="shrink-0">
                {t("Recommended")}
              </Badge>
            ) : null}
          </button>
        ))}
      </div>
    </GenerativeFrame>
  );
}
