import { ApprovalRequestId } from "@akeru/contracts";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import type { PendingUserInput } from "../../session-logic";
import { BotUserInputPrompt } from "./BotUserInputPrompt";

vi.mock("../../i18n", async () => {
  const { createTranslator } = await import("@akeru/client-runtime/i18n");
  const translator = createTranslator("en");

  return { useI18n: () => ({ ...translator, t: translator.translate }) };
});

const prompt: PendingUserInput = {
  requestId: ApprovalRequestId.make("request-1"),
  createdAt: "2026-09-01T00:00:00.000Z",
  questions: [
    {
      id: "review-mode",
      header: "Review mode",
      question: "How should Auto Review handle commands that change files?",
      options: [
        {
          label: "Review risky commands",
          description: "Allow routine commands and ask before risky changes.",
        },
      ],
      multiSelect: false,
    },
  ],
};

describe("BotUserInputPrompt", () => {
  it("renders the pending question as an attached composer action", () => {
    const markup = renderToStaticMarkup(
      <BotUserInputPrompt
        pendingUserInputs={[prompt]}
        respondingRequestIds={[]}
        answers={{}}
        step={0}
        onStepChange={vi.fn()}
        onSelectOption={vi.fn()}
        onAnswerWithText={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(markup).toContain('data-testid="bot-user-input-prompt"');
    expect(markup).toContain("How should Auto Review handle commands that change files?");
    expect(markup).toContain("Review risky commands");
  });

  it("hands the panel its select, step, and submit callbacks without chrome", () => {
    const onSelectOption = vi.fn();
    const onStepChange = vi.fn();
    const onSubmit = vi.fn();
    const onAnswerWithText = vi.fn();

    const element = BotUserInputPrompt({
      pendingUserInputs: [prompt],
      respondingRequestIds: [],
      answers: {},
      step: 0,
      onStepChange,
      onSelectOption,
      onAnswerWithText,
      onSubmit,
    });

    if (!element) throw new TypeError("Expected an unanswered prompt.");

    const panel = element.props.children as ReactElement<{
      onSelectOption?: (questionId: string, optionLabel: string) => void;
      onAnswerWithText?: (text: string) => void;
      onStepChange?: (step: number) => void;
      onSubmit?: () => void;
      surface?: string;
    }>;

    expect(panel.props.onSelectOption).toBe(onSelectOption);
    expect(panel.props.onAnswerWithText).toBe(onAnswerWithText);
    expect(panel.props.onStepChange).toBe(onStepChange);
    expect(panel.props.onSubmit).toBe(onSubmit);
    expect(panel.props.surface).toBe("docked");
  });

  it("clears itself once the answer is on its way", () => {
    expect(
      BotUserInputPrompt({
        pendingUserInputs: [prompt],
        respondingRequestIds: [prompt.requestId],
        answers: {},
        step: 0,
        onStepChange: vi.fn(),
        onSelectOption: vi.fn(),
        onAnswerWithText: vi.fn(),
        onSubmit: vi.fn(),
      }),
    ).toBeNull();
    expect(
      BotUserInputPrompt({
        pendingUserInputs: [],
        respondingRequestIds: [],
        answers: {},
        step: 0,
        onStepChange: vi.fn(),
        onSelectOption: vi.fn(),
        onAnswerWithText: vi.fn(),
        onSubmit: vi.fn(),
      }),
    ).toBeNull();
  });
});
