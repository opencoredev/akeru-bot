import { CheckIcon, CornerDownLeftIcon, PencilLineIcon } from "lucide-react";
import { useState, type ReactNode, type RefObject } from "react";
import { useI18n } from "~/i18n";
import { cn } from "~/lib/utils";
import { Kbd } from "../ui/kbd";

/** Single-choice questions show a radio mark; multi-select questions show a checkbox. */
export type ChoiceKind = "radio" | "checkbox";

/** The selection mark at the start of a choice row. Purely visual; the row carries the state. */
function ChoiceMark({
  kind,
  checked,
  className,
}: {
  kind: ChoiceKind;
  checked: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn("gen-mark", className)}
      data-kind={kind}
      data-checked={checked ? "true" : undefined}
    >
      {kind === "checkbox" ? (
        <CheckIcon className="gen-mark-tick" strokeWidth={3} />
      ) : (
        <span className="gen-mark-dot" />
      )}
    </span>
  );
}

/** The number key that picks this row. Hidden on touch screens, where there is no keyboard. */
function ShortcutHint({ shortcut }: { shortcut: string }) {
  return <Kbd className="mt-0.5 shrink-0 pointer-coarse:hidden">{shortcut}</Kbd>;
}

export function ChoiceButton({
  kind,
  pressed,
  disabled,
  shortcut,
  onClick,
  children,
}: {
  kind: ChoiceKind;
  pressed: boolean;
  disabled: boolean;
  shortcut: string | null;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="gen-choice flex w-full items-start gap-3 rounded-xl border border-border bg-background px-3 py-2.5 text-left transition-colors enabled:hover:bg-accent disabled:cursor-default"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      <ChoiceMark kind={kind} checked={pressed} className="mt-0.5" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">{children}</span>
      {shortcut ? <ShortcutHint shortcut={shortcut} /> : null}
    </button>
  );
}

/**
 * The last row takes a typed answer in place, styled like the options above it. Enter answers
 * the question on screen; a reply sent from the composer lands here too.
 */
export function OwnAnswerRow({
  kind,
  answer,
  disabled,
  inputRef,
  onAnswer,
}: {
  kind: ChoiceKind;
  answer: string;
  disabled: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onAnswer: (text: string) => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState(answer);
  const [shownAnswer, setShownAnswer] = useState(answer);

  // An answer sent from the composer replaces whatever is in the row.
  if (shownAnswer !== answer) {
    setShownAnswer(answer);
    setText(answer);
  }

  const trimmed = text.trim();
  const answered = answer !== "" && trimmed === answer;

  return (
    <label
      className={cn(
        "gen-choice flex w-full items-center gap-3 rounded-xl border border-border bg-background px-3 py-2.5 transition-colors focus-within:border-solid has-focus-visible:ring-2 has-focus-visible:ring-ring",
        !trimmed && "border-dashed",
      )}
      data-selected={answered ? "true" : undefined}
    >
      {answered ? (
        <ChoiceMark kind={kind} checked />
      ) : (
        <PencilLineIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      )}
      <input
        ref={inputRef}
        type="text"
        className="min-w-0 flex-1 bg-transparent text-sm font-medium text-foreground outline-none placeholder:font-normal placeholder:text-muted-foreground"
        placeholder={t("Type your own answer")}
        aria-label={t("Type your own answer")}
        value={text}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing || !trimmed) return;
          event.preventDefault();
          onAnswer(trimmed);
        }}
      />
      {trimmed && !answered ? (
        <Kbd className="shrink-0">
          <CornerDownLeftIcon />
        </Kbd>
      ) : null}
    </label>
  );
}
