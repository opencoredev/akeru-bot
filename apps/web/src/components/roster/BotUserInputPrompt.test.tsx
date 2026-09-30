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
        questionIndex={0}
        onToggleOption={vi.fn()}
        onSelectSingleOption={vi.fn()}
        onAdvance={vi.fn()}
      />,
    );

    expect(markup).toContain('data-testid="bot-user-input-prompt"');
    expect(markup).toContain("How should Auto Review handle commands that change files?");
    expect(markup).toContain("Review risky commands");
  });

  it("uses one callback for single-select answers", () => {
    const onToggleOption = vi.fn();
    const onSelectSingleOption = vi.fn();
    const element = BotUserInputPrompt({
      pendingUserInputs: [prompt],
      respondingRequestIds: [],
      answers: {},
      questionIndex: 0,
      onToggleOption,
      onSelectSingleOption,
      onAdvance: vi.fn(),
    });
    if (!element) throw new TypeError("Expected an unanswered prompt.");
    const panel = (
      element.props.children as ReactElement<{
        onSelectSingleOption?: (questionId: string, optionLabel: string) => void;
      }>[]
    )[0];
    if (!panel) throw new TypeError("Expected a question panel.");

    expect(panel.props.onSelectSingleOption).toBe(onSelectSingleOption);
  });

  it("clears itself once the answer is on its way", () => {
    expect(
      BotUserInputPrompt({
        pendingUserInputs: [prompt],
        respondingRequestIds: [prompt.requestId],
        answers: {},
        questionIndex: 0,
        onToggleOption: vi.fn(),
        onSelectSingleOption: vi.fn(),
        onAdvance: vi.fn(),
      }),
    ).toBeNull();
    expect(
      BotUserInputPrompt({
        pendingUserInputs: [],
        respondingRequestIds: [],
        answers: {},
        questionIndex: 0,
        onToggleOption: vi.fn(),
        onSelectSingleOption: vi.fn(),
        onAdvance: vi.fn(),
      }),
    ).toBeNull();
  });
});
