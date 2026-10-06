import { describe, expect, it } from "vite-plus/test";

import {
  pendingUserInputKeyAction,
  applyPendingUserInputOptionSelection,
  buildPendingUserInputAnswers,
  countAnsweredPendingUserInputQuestions,
  findFirstUnansweredPendingUserInputQuestionIndex,
  resolvePendingUserInputAnswer,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "./pendingUserInput";

const singleSelectQuestion = {
  id: "scope",
  header: "Scope",
  question: "What should the plan target first?",
  options: [
    {
      label: "Orchestration-first",
      description: "Focus on orchestration first",
    },
  ],
  multiSelect: false,
} as const;

const multiSelectQuestion = {
  id: "areas",
  header: "Areas",
  question: "Which areas should this change cover?",
  options: [
    {
      label: "Server",
      description: "Server",
    },
    {
      label: "Web",
      description: "Web",
    },
  ],
  multiSelect: true,
} as const;

describe("resolvePendingUserInputAnswer", () => {
  it("prefers a custom answer over selected options", () => {
    expect(
      resolvePendingUserInputAnswer(singleSelectQuestion, {
        selectedOptionLabels: ["Orchestration-first"],
        customAnswer: "Keep the existing envelope for one release",
      }),
    ).toBe("Keep the existing envelope for one release");
  });

  it("falls back to the selected option for single-select questions", () => {
    expect(
      resolvePendingUserInputAnswer(singleSelectQuestion, {
        selectedOptionLabels: ["Orchestration-first"],
      }),
    ).toBe("Orchestration-first");
  });

  it("returns all selected labels for multi-select questions", () => {
    expect(
      resolvePendingUserInputAnswer(multiSelectQuestion, {
        selectedOptionLabels: ["Server", "Web"],
      }),
    ).toEqual(["Server", "Web"]);
  });

  it("clears the preset selection when a custom answer is entered", () => {
    expect(
      setPendingUserInputCustomAnswer(
        {
          selectedOptionLabels: ["Server", "Web"],
        },
        "doesn't matter",
      ),
    ).toEqual({
      customAnswer: "doesn't matter",
    });
  });
});

describe("togglePendingUserInputOptionSelection", () => {
  it("toggles options for multi-select questions", () => {
    expect(togglePendingUserInputOptionSelection(multiSelectQuestion, undefined, "Server")).toEqual(
      {
        customAnswer: "",
        selectedOptionLabels: ["Server"],
      },
    );

    expect(
      togglePendingUserInputOptionSelection(
        multiSelectQuestion,
        {
          selectedOptionLabels: ["Server", "Web"],
        },
        "Server",
      ),
    ).toEqual({
      customAnswer: "",
      selectedOptionLabels: ["Web"],
    });
  });
});

describe("applyPendingUserInputOptionSelection", () => {
  const second = { ...singleSelectQuestion, id: "second" };

  it("sends a lone single-select question on click", () => {
    expect(
      applyPendingUserInputOptionSelection(
        [singleSelectQuestion],
        {},
        "scope",
        "Orchestration-first",
      ),
    ).toEqual({
      draftAnswers: {
        scope: { customAnswer: "", selectedOptionLabels: ["Orchestration-first"] },
      },
      answers: { scope: "Orchestration-first" },
      nextStep: 0,
    });
  });

  it("moves to the next step instead of sending, even once every answer is in", () => {
    const draftAnswers = { second: { selectedOptionLabels: ["Orchestration-first"] } };

    expect(
      applyPendingUserInputOptionSelection(
        [singleSelectQuestion, second],
        draftAnswers,
        "scope",
        "Orchestration-first",
      ),
    ).toMatchObject({ answers: null, nextStep: 1 });
  });

  it("sends from the last step once every question is answered", () => {
    const draftAnswers = { scope: { selectedOptionLabels: ["Orchestration-first"] } };

    expect(
      applyPendingUserInputOptionSelection(
        [singleSelectQuestion, second],
        draftAnswers,
        "second",
        "Orchestration-first",
      ),
    ).toMatchObject({
      answers: { scope: "Orchestration-first", second: "Orchestration-first" },
    });
  });

  it("returns to the first open step when the last one is answered early", () => {
    expect(
      applyPendingUserInputOptionSelection(
        [singleSelectQuestion, second],
        {},
        "second",
        "Orchestration-first",
      ),
    ).toMatchObject({ answers: null, nextStep: 0 });
  });

  it("keeps a multi-select step open while picks toggle", () => {
    expect(
      applyPendingUserInputOptionSelection(
        [singleSelectQuestion, multiSelectQuestion],
        {},
        "areas",
        multiSelectQuestion.options[0].label,
      ),
    ).toMatchObject({ answers: null, nextStep: 1 });
  });

  it("ignores options the question does not offer", () => {
    expect(
      applyPendingUserInputOptionSelection([singleSelectQuestion], {}, "scope", "Nope"),
    ).toBeNull();
  });
});

describe("buildPendingUserInputAnswers", () => {
  it("returns a canonical answer map for complete prompts", () => {
    expect(
      buildPendingUserInputAnswers(
        [
          singleSelectQuestion,
          {
            id: "compat",
            header: "Compat",
            question: "How strict should compatibility be?",
            options: [
              {
                label: "Keep current envelope",
                description: "Preserve current wire format",
              },
            ],
            multiSelect: false,
          },
        ],
        {
          scope: {
            selectedOptionLabels: ["Orchestration-first"],
          },
          compat: {
            customAnswer: "Keep the current envelope for one release window",
          },
        },
      ),
    ).toEqual({
      scope: "Orchestration-first",
      compat: "Keep the current envelope for one release window",
    });
  });

  it("returns arrays for answered multi-select prompts", () => {
    expect(
      buildPendingUserInputAnswers([multiSelectQuestion], {
        areas: {
          selectedOptionLabels: ["Server", "Web"],
        },
      }),
    ).toEqual({
      areas: ["Server", "Web"],
    });
  });

  it("returns null when any question is unanswered", () => {
    expect(buildPendingUserInputAnswers([singleSelectQuestion], {})).toBeNull();
  });
});

describe("pending user input question progress", () => {
  const questions = [
    singleSelectQuestion,
    {
      id: "compat",
      header: "Compat",
      question: "How strict should compatibility be?",
      options: [
        {
          label: "Keep current envelope",
          description: "Preserve current wire format",
        },
      ],
      multiSelect: false,
    },
  ] as const;

  it("counts only answered questions", () => {
    expect(
      countAnsweredPendingUserInputQuestions(questions, {
        scope: {
          selectedOptionLabels: ["Orchestration-first"],
        },
      }),
    ).toBe(1);
  });

  it("finds the first unanswered question", () => {
    expect(
      findFirstUnansweredPendingUserInputQuestionIndex(questions, {
        scope: {
          selectedOptionLabels: ["Orchestration-first"],
        },
      }),
    ).toBe(1);
  });

  it("returns the last question index when all answers are complete", () => {
    expect(
      findFirstUnansweredPendingUserInputQuestionIndex(questions, {
        scope: {
          selectedOptionLabels: ["Orchestration-first"],
        },
        compat: {
          customAnswer: "Keep it for one release window",
        },
      }),
    ).toBe(1);
  });
});

describe("pendingUserInputKeyAction", () => {
  it("picks an option by number and starts a typed answer for other characters", () => {
    expect(pendingUserInputKeyAction("2", 3)).toEqual({ kind: "pick", optionIndex: 1 });
    expect(pendingUserInputKeyAction("a", 3)).toEqual({ kind: "type" });
    expect(pendingUserInputKeyAction("H", 3)).toEqual({ kind: "type" });
    // A number past the last option is part of a typed answer, not a pick.
    expect(pendingUserInputKeyAction("7", 3)).toEqual({ kind: "type" });
  });

  it("ignores whitespace and named keys", () => {
    expect(pendingUserInputKeyAction(" ", 3)).toBeNull();
    expect(pendingUserInputKeyAction("Tab", 3)).toBeNull();
    expect(pendingUserInputKeyAction("ArrowDown", 3)).toBeNull();
  });
});
