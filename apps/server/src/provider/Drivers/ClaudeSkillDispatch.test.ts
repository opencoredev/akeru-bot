import { describe, expect, it } from "vite-plus/test";

import { planClaudeSkillDispatch } from "./ClaudeSkillDispatch.ts";

const SKILLS = new Set(["implement", "review", "re-release-version", "123-review"]);

describe("planClaudeSkillDispatch", () => {
  it("leaves prompts without a known skill mention unchanged", () => {
    expect(planClaudeSkillDispatch("fix the build", SKILLS)).toBeUndefined();
    expect(planClaudeSkillDispatch("echo $HOME then $unknown", SKILLS)).toBeUndefined();
  });

  it("splits the last known skill mention into a trailing slash command", () => {
    expect(planClaudeSkillDispatch("ok, now $implement all the tickets", SKILLS)).toEqual({
      leadingText: "ok, now",
      commandText: "/implement all the tickets",
      skillName: "implement",
    });
    expect(planClaudeSkillDispatch("$review\nfocus on auth", SKILLS)).toEqual({
      leadingText: undefined,
      commandText: "/review\nfocus on auth",
      skillName: "review",
    });
    expect(planClaudeSkillDispatch("$review the diff, then $implement the fixes", SKILLS)).toEqual({
      leadingText: "/review the diff, then",
      commandText: "/implement the fixes",
      skillName: "implement",
    });
  });

  it("dispatches a numeric-leading discovered skill", () => {
    expect(planClaudeSkillDispatch("use $123-review now", SKILLS)).toEqual({
      leadingText: "use",
      commandText: "/123-review now",
      skillName: "123-review",
    });
  });

  it("does not treat a dollar amount glued to a word as a skill", () => {
    expect(planClaudeSkillDispatch("cost is 5$implement", SKILLS)).toBeUndefined();
  });

  it("keeps prices literal", () => {
    expect(planClaudeSkillDispatch("it costs $5 or $ 10, not $5.99", SKILLS)).toBeUndefined();
  });

  it("keeps known skill names inside quotes literal", () => {
    expect(planClaudeSkillDispatch("printf ' $implement '", SKILLS)).toBeUndefined();
    expect(planClaudeSkillDispatch('echo "run $implement now"', SKILLS)).toBeUndefined();
  });

  it("keeps a $skill after an escaped quote inside a double-quoted string literal", () => {
    expect(planClaudeSkillDispatch('echo "run \\" $implement"', SKILLS)).toBeUndefined();
  });

  it("keeps a $skill inside a multiline double-quoted string literal", () => {
    expect(planClaudeSkillDispatch('echo "first\n$implement\nlast"', SKILLS)).toBeUndefined();
  });

  it("keeps a $skill inside a multiline single-quoted string literal", () => {
    expect(planClaudeSkillDispatch("echo 'first\n$implement\nlast'", SKILLS)).toBeUndefined();
  });

  it("still dispatches a real mention after a properly closed multiline quote", () => {
    expect(planClaudeSkillDispatch('echo "first\nline"\n$implement the fix', SKILLS)).toEqual({
      leadingText: 'echo "first\nline"',
      commandText: "/implement the fix",
      skillName: "implement",
    });
    expect(planClaudeSkillDispatch("echo 'first\nline'\n$implement the fix", SKILLS)).toEqual({
      leadingText: "echo 'first\nline'",
      commandText: "/implement the fix",
      skillName: "implement",
    });
  });

  it("keeps known skill names inside inline and fenced code literal", () => {
    expect(planClaudeSkillDispatch("run `echo $implement` first", SKILLS)).toBeUndefined();
    expect(planClaudeSkillDispatch("run ``a ` $implement`` first", SKILLS)).toBeUndefined();
    expect(
      planClaudeSkillDispatch("see this:\n```sh\necho $implement\n```\nthanks", SKILLS),
    ).toBeUndefined();
    expect(planClaudeSkillDispatch("unclosed:\n~~~\n$implement", SKILLS)).toBeUndefined();
  });

  it("still dispatches a real mention next to quoted, coded, or apostrophe text", () => {
    expect(
      planClaudeSkillDispatch(
        "don't wait, it's fine: `echo $review` and \"$review\" then $implement it",
        SKILLS,
      ),
    ).toEqual({
      leadingText: "don't wait, it's fine: `echo $review` and \"$review\" then",
      commandText: "/implement it",
      skillName: "implement",
    });
    expect(planClaudeSkillDispatch("```\n$review\n```\n$implement the fix", SKILLS)).toEqual({
      leadingText: "```\n$review\n```",
      commandText: "/implement the fix",
      skillName: "implement",
    });
  });
});
