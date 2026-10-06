import type { AnsweredUserInputQuestion } from "@akeru/client-runtime/user-input-answers";
import { CheckIcon, PencilLineIcon } from "lucide-react";
import { useI18n } from "~/i18n";

/**
 * A submitted answer to a bot's questions, read back as a short summary: one divided row per
 * question with what was picked. Multi-select picks list one per line, and an answer typed in
 * place of the options is marked with a pencil.
 */
export function UserInputAnswerCard({
  answered,
}: {
  readonly answered: ReadonlyArray<AnsweredUserInputQuestion>;
}) {
  const { t } = useI18n();

  return (
    <div
      className="chat-generative flex w-72 max-w-full flex-col overflow-hidden rounded-2xl border border-border bg-card"
      data-generative="answer"
      data-testid="user-input-answer-card"
    >
      <div className="flex items-center gap-2 border-b border-border px-3.5 py-2 text-xs font-medium text-muted-foreground">
        <span className="gen-answer-badge">
          <CheckIcon className="size-2.5" strokeWidth={3} />
        </span>
        {answered.length === 1
          ? t("Answered")
          : t("Answered {count} questions", { count: String(answered.length) })}
      </div>
      <dl className="flex flex-col divide-y divide-border">
        {answered.map(({ question, answers }) => {
          const optionOrder = question.options.map((option) => option.label);
          const optionLabels = new Set(optionOrder);

          // Picks read in the order the bot offered them; typed answers come last.
          const rank = (answer: string) =>
            optionLabels.has(answer) ? optionOrder.indexOf(answer) : optionOrder.length;

          return (
            <div key={question.id} className="flex flex-col gap-1 px-3.5 py-2.5">
              <dt className="text-xs text-muted-foreground">
                {question.header && question.header !== question.question
                  ? question.header
                  : question.question}
              </dt>
              {[...new Set(answers)]
                .toSorted((left, right) => rank(left) - rank(right))
                .map((answer) => (
                  <dd
                    key={answer}
                    className="flex items-start gap-2 text-sm font-medium text-foreground"
                  >
                    {optionLabels.has(answer) ? (
                      question.multiSelect ? (
                        <CheckIcon
                          aria-hidden="true"
                          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                        />
                      ) : null
                    ) : (
                      <PencilLineIcon
                        aria-hidden="true"
                        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                      />
                    )}
                    <span className="min-w-0 break-words">{answer}</span>
                  </dd>
                ))}
            </div>
          );
        })}
      </dl>
    </div>
  );
}
