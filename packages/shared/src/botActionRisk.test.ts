import { describe, expect, it } from "vite-plus/test";

import { claudeCodeToolRiskClass } from "./botActionRisk.ts";

describe("claudeCodeToolRiskClass", () => {
  it("treats reads and planning tools as reads", () => {
    expect(claudeCodeToolRiskClass("Read", { file_path: "src/index.ts" })).toBe("read");
    expect(claudeCodeToolRiskClass("Grep", { pattern: "TODO" })).toBe("read");
    expect(claudeCodeToolRiskClass("AskUserQuestion", { questions: [] })).toBe("read");
  });

  it("treats file edits as workspace writes", () => {
    expect(claudeCodeToolRiskClass("Edit", { file_path: "a.ts" })).toBe("write-workspace");
    expect(claudeCodeToolRiskClass("Write", { file_path: "a.ts", content: "x" })).toBe(
      "write-workspace",
    );
  });

  it("treats the shell as access to the user's computer", () => {
    expect(claudeCodeToolRiskClass("Bash", { command: "ls -la" })).toBe("environment-access");
  });

  it("treats protected shell commands and secret reads as outside writes", () => {
    expect(claudeCodeToolRiskClass("Bash", { command: "git push --force" })).toBe("write-outside");
    expect(claudeCodeToolRiskClass("Bash", { command: "rm -rf build" })).toBe("write-outside");
    expect(claudeCodeToolRiskClass("Read", { file_path: "/home/me/.ssh/id_rsa" })).toBe(
      "write-outside",
    );
  });

  it("classifies Akeru's own MCP tools by name and other MCP tools as outside writes", () => {
    expect(claudeCodeToolRiskClass("mcp__akeru__memory", { command: "view" })).toBe(
      "write-workspace",
    );
    expect(claudeCodeToolRiskClass("mcp__akeru__preview_list", {})).toBe("read");
    expect(claudeCodeToolRiskClass("mcp__github__create_issue", { title: "x" })).toBe(
      "write-outside",
    );
    expect(claudeCodeToolRiskClass("SomeNewTool", {})).toBe("write-outside");
  });

  it("treats file tools that leave the workspace as access to the user's computer", () => {
    expect(
      claudeCodeToolRiskClass("Read", { file_path: "/home/x/Documents/a.txt" }, "outside"),
    ).toBe("environment-access");
    expect(claudeCodeToolRiskClass("Write", { file_path: "/home/x/.bashrc" }, "outside")).toBe(
      "write-outside",
    );
    expect(claudeCodeToolRiskClass("Edit", { file_path: "src/a.ts" }, "inside")).toBe(
      "write-workspace",
    );
  });

  it("gives Akeru's image tool the same risk as GenerateImage", () => {
    expect(
      claudeCodeToolRiskClass("mcp__akeru__generate_image", {
        operation: "generate",
        prompt: "A kite",
      }),
    ).toBe("write-outside");
    expect(claudeCodeToolRiskClass("mcp__akeru__memory", { action: "read" })).toBe(
      "write-workspace",
    );
  });
});
