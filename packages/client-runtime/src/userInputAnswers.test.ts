import { EventId, type OrchestrationThreadActivity } from "@akeru/contracts";
import { describe, expect, it } from "vite-plus/test";

import { answeredUserInputForMessage, deriveAskedUserInputs } from "./userInputAnswers.ts";

const questions = [
  {
    id: "audience",
    header: "Audience",
    question: "Who is this for?",
    multiSelect: false,
    options: [
      { label: "New developers", description: "First week" },
      { label: "Existing users", description: "Upgrading" },
    ],
  },
  {
    id: "features",
    header: "Features",
    question: "What should it cover?",
    multiSelect: true,
    options: [
      { label: "Chat blocks", description: "Charts and cards" },
      { label: "Sign in", description: "No CLIs" },
      { label: "Channels", description: "Slack and Telegram" },
    ],
  },
];

function activity(
  kind: string,
  payload: OrchestrationThreadActivity["payload"],
): OrchestrationThreadActivity {
  return {
    id: EventId.make(`${kind}-activity`),
    createdAt: "2026-10-02T00:00:00.000Z",
    kind,
    summary: kind,
    tone: "info",
    payload,
    turnId: null,
  };
}

const requested = activity("user-input.requested", { requestId: "req-1", questions });

const messageId = "user-input:thread-1:req-1";

describe("answeredUserInputForMessage", () => {
  it("pairs answer lines with their questions, grouping multi-select picks", () => {
    const asked = deriveAskedUserInputs([requested]);

    const answered = answeredUserInputForMessage(
      { id: messageId, text: "New developers\nChat blocks\nChannels" },
      asked,
    );

    expect(answered?.map(({ question, answers }) => [question.id, answers])).toEqual([
      ["audience", ["New developers"]],
      ["features", ["Chat blocks", "Channels"]],
    ]);
  });

  it("prefers the answers the provider confirmed", () => {
    const asked = deriveAskedUserInputs([
      requested,
      activity("user-input.resolved", {
        requestId: "req-1",
        answers: { audience: "Teams", features: ["Sign in"] },
      }),
    ]);

    const answered = answeredUserInputForMessage({ id: messageId, text: "ignored" }, asked);

    expect(answered?.map(({ answers }) => answers)).toEqual([["Teams"], ["Sign in"]]);
  });

  it("keeps a typed answer for a question", () => {
    const asked = deriveAskedUserInputs([requested]);

    const answered = answeredUserInputForMessage(
      { id: messageId, text: "Designers\nSomething custom" },
      asked,
    );

    expect(answered?.map(({ answers }) => answers)).toEqual([["Designers"], ["Something custom"]]);
  });

  it("shows the plain message rather than guess when a typed answer spans lines", () => {
    const asked = deriveAskedUserInputs([requested]);

    // "Designers\nand PMs" answers the first question; the extra line cannot be placed.
    expect(
      answeredUserInputForMessage({ id: messageId, text: "Designers\nand PMs\nChannels" }, asked),
    ).toBeNull();
  });

  it("falls back to text when lines do not line up or the message is ordinary", () => {
    const asked = deriveAskedUserInputs([requested]);

    expect(answeredUserInputForMessage({ id: messageId, text: "Only one" }, asked)).toBeNull();
    expect(
      answeredUserInputForMessage({ id: "message-1", text: "New developers" }, asked),
    ).toBeNull();
    expect(
      answeredUserInputForMessage({ id: "user-input:thread-1:req-other", text: "x\ny" }, asked),
    ).toBeNull();
  });
});
