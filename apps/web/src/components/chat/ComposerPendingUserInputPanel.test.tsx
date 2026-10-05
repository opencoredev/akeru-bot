import { ApprovalRequestId } from "@akeru/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import type { PendingUserInput } from "../../session-logic";

const approachQuestion = {
  id: "question-1",
  header: "Approach",
  question: "Which approach should the migration take?",
  options: [
    { label: "Incremental", description: "Move one module at a time" },
    { label: "Big bang", description: "Move everything in one release" },
  ],
  multiSelect: false,
};

const areasQuestion = {
  id: "question-2",
  header: "Areas",
  question: "Which areas should it cover first?",
  options: [
    { label: "Server", description: "Server" },
    { label: "Web", description: "Web" },
  ],
  multiSelect: true,
};

function prompt(questions: PendingUserInput["questions"]): PendingUserInput {
  return {
    requestId: ApprovalRequestId.make("request-1"),
    createdAt: "2026-08-15T00:00:00.000Z",
    questions,
  };
}

function renderPanel(
  questions: PendingUserInput["questions"],
  answers: Parameters<typeof ComposerPendingUserInputPanel>[0]["answers"] = {},
  step = 0,
) {
  return renderToStaticMarkup(
    <ComposerPendingUserInputPanel
      pendingUserInputs={[prompt(questions)]}
      respondingRequestIds={[]}
      answers={answers}
      step={step}
      onStepChange={() => {}}
      onSelectOption={() => {}}
      onAnswerWithText={() => {}}
      onSubmit={() => {}}
    />,
  );
}

const disabledButton = (label: string) =>
  new RegExp(`<button[^>]*disabled=""[^>]*>${label}</button>`);

describe("ComposerPendingUserInputPanel", () => {
  it("sends a lone single-choice question on click, so it shows no steps or Submit", () => {
    const markup = renderPanel([approachQuestion]);

    expect(markup).toContain('data-testid="pending-user-input-card"');
    expect(markup).toContain('aria-label="Which approach should the migration take?"');
    expect(markup).toContain(">1</kbd>");
    expect(markup).toContain(">2</kbd>");
    expect(markup).not.toContain(">Submit</button>");
    expect(markup).not.toContain("gen-step");
  });

  it("shows one question at a time with its place in the set", () => {
    const markup = renderPanel([approachQuestion, areasQuestion]);

    expect(markup).toContain("Which approach should the migration take?");
    expect(markup).not.toContain("Which areas should it cover first?");
    expect(markup).toContain("1 of 2");
    expect(markup).toContain('data-state="current"');
    expect(markup).not.toContain(">Back</button>");
  });

  it("waits for Next on an unanswered step", () => {
    const open = renderPanel([approachQuestion, areasQuestion]);
    expect(open).toMatch(disabledButton("Next"));

    const answered = renderPanel([approachQuestion, areasQuestion], {
      "question-1": { selectedOptionLabels: ["Incremental"] },
    });

    expect(answered).toContain(">Next</button>");
    expect(answered).not.toMatch(disabledButton("Next"));
  });

  it("offers Back and Submit on the last step, enabled once every question is answered", () => {
    const partial = renderPanel([approachQuestion, areasQuestion], {}, 1);

    expect(partial).toContain("Which areas should it cover first?");
    expect(partial).toContain("Pick any that apply.");
    expect(partial).toMatch(/<svg[^>]*>.*<\/svg>Back<\/button>/);
    expect(partial).toMatch(disabledButton("Submit"));

    const complete = renderPanel(
      [approachQuestion, areasQuestion],
      {
        "question-1": { selectedOptionLabels: ["Incremental"] },
        "question-2": { selectedOptionLabels: ["Web"] },
      },
      1,
    );

    expect(complete).toContain('data-state="done"');
    expect(complete).toContain(">Submit</button>");
    expect(complete).not.toMatch(disabledButton("Submit"));
  });

  it("dims the other options of an answered single choice, but never of a multi-select", () => {
    const answers = {
      "question-1": { selectedOptionLabels: ["Incremental"] },
      "question-2": { selectedOptionLabels: ["Web"] },
    };

    expect(renderPanel([approachQuestion, areasQuestion], answers, 0)).toContain(
      'data-answered="true"',
    );
    expect(renderPanel([approachQuestion, areasQuestion], answers, 1)).toContain(
      'data-answered="false"',
    );
  });

  it("offers a row for a typed answer and fills it in once one is typed", () => {
    const empty = renderPanel([approachQuestion, areasQuestion], {});

    expect(empty).toContain('placeholder="Type your own answer"');
    expect(empty).not.toContain('data-selected="true"');

    const markup = renderPanel([approachQuestion, areasQuestion], {
      "question-1": { customAnswer: "Whatever is safest" },
    });

    expect(markup).toContain('value="Whatever is safest"');
    expect(markup).toContain('data-selected="true"');
    expect(markup).not.toContain('aria-pressed="true"');
  });
});
