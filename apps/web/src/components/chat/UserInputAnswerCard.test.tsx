import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { UserInputAnswerCard } from "./UserInputAnswerCard";

const scope = {
  id: "scope",
  header: "Scope",
  question: "Which suites should I touch?",
  multiSelect: true,
  options: [
    { label: "Server", description: "Reaper tests" },
    { label: "Web", description: "Reconnect tests" },
    { label: "Mobile", description: "Session restore tests" },
  ],
};

const fix = {
  id: "fix",
  header: "Fix",
  question: "How should I fix the reaper tests?",
  multiSelect: false,
  options: [
    { label: "Wait on receipts", description: "Replace the sleeps" },
    { label: "Raise the timeout", description: "Keeps the race" },
  ],
};

describe("UserInputAnswerCard", () => {
  it("lists multi-select picks in the order the bot offered them", () => {
    const markup = renderToStaticMarkup(
      <UserInputAnswerCard answered={[{ question: scope, answers: ["Mobile", "Server"] }]} />,
    );

    expect(markup.indexOf("Server")).toBeLessThan(markup.indexOf("Mobile"));
    expect(
      renderToStaticMarkup(
        <UserInputAnswerCard answered={[{ question: scope, answers: ["Server", "Server"] }]} />,
      ).match(/>Server</g),
    ).toHaveLength(1);
    expect(markup).toContain("Answered");
  });

  it("marks a typed answer with a pencil and leaves a single pick plain", () => {
    const typed = renderToStaticMarkup(
      <UserInputAnswerCard answered={[{ question: fix, answers: ["Receipts, then delete"] }]} />,
    );

    const picked = renderToStaticMarkup(
      <UserInputAnswerCard answered={[{ question: fix, answers: ["Wait on receipts"] }]} />,
    );

    expect(typed).toContain("lucide-pencil-line");
    expect(picked).not.toContain("lucide-pencil-line");
    // Only the header badge carries a check; a single pick reads as plain text.
    expect(picked.match(/lucide-check\b/g)).toHaveLength(1);
  });
});
