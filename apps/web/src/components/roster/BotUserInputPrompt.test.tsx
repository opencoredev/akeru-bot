import { ApprovalRequestId } from "@t3tools/contracts";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import type { PendingUserInput } from "../../session-logic";
import { BotUserInputPrompt } from "./BotUserInputPrompt";

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
        onAdvance={vi.fn()}
      />,
    );

    expect(markup).toContain('data-testid="bot-user-input-prompt"');
    expect(markup).toContain("How should Auto Review handle commands that change files?");
    expect(markup).toContain("Review risky commands");
  });

  it("uses one callback for single-select answers", () => {
    const onToggleOption = vi.fn();
    const element = BotUserInputPrompt({
      pendingUserInputs: [prompt],
      respondingRequestIds: [],
      answers: {},
      questionIndex: 0,
      onToggleOption,
      onAdvance: vi.fn(),
    });
    const panel = element.props.children as ReactElement<{
      onSelectSingleOption?: (questionId: string, optionLabel: string) => void;
    }>;

    expect(panel.props.onSelectSingleOption).toBe(onToggleOption);
  });
});
