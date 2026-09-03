import { ApprovalRequestId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import type { PendingUserInput } from "../../session-logic";

const prompt: PendingUserInput = {
  requestId: ApprovalRequestId.make("request-1"),
  createdAt: "2026-08-15T00:00:00.000Z",
  questions: [
    {
      id: "question-1",
      header: "Approach",
      question: "Which approach should the migration take?",
      options: [
        { label: "Incremental", description: "Move one module at a time" },
        { label: "Big bang", description: "Move everything in one release" },
      ],
      multiSelect: false,
    },
  ],
};

function renderPanel() {
  return renderToStaticMarkup(
    <ComposerPendingUserInputPanel
      pendingUserInputs={[prompt]}
      respondingRequestIds={[]}
      answers={{}}
      questionIndex={0}
      onToggleOption={() => {}}
    />,
  );
}

describe("ComposerPendingUserInputPanel", () => {
  it("renders a standalone question card with letter shortcuts", () => {
    const markup = renderPanel();

    expect(markup).toContain('data-testid="pending-user-input-card"');
    expect(markup).toContain('aria-label="Which approach should the migration take?"');
    expect(markup).toContain("<kbd");
    expect(markup).toContain(">A</kbd>");
    expect(markup).toContain(">B</kbd>");
    expect(markup).not.toContain("data-pending-user-input-toggle");
  });

  it("starts expanded so the question and its options are visible", () => {
    const markup = renderPanel();

    expect(markup).toContain("Which approach should the migration take?");
    expect(markup).toContain("Incremental");
    expect(markup).toContain("Big bang");
  });

  it("shows a submit action after a multi-select answer is selected", () => {
    const multiSelectPrompt: PendingUserInput = {
      ...prompt,
      questions: [{ ...prompt.questions[0]!, multiSelect: true }],
    };
    const markup = renderToStaticMarkup(
      <ComposerPendingUserInputPanel
        pendingUserInputs={[multiSelectPrompt]}
        respondingRequestIds={[]}
        answers={{ "question-1": { selectedOptionLabels: ["Incremental"] } }}
        questionIndex={0}
        onToggleOption={() => {}}
        onAdvance={() => {}}
      />,
    );

    expect(markup).toContain(">Submit</button>");
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('aria-pressed="false"');
  });
});
