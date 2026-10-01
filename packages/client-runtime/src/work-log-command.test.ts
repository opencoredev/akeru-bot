import { describe, expect, it } from "vite-plus/test";
import {
  extractToolCommand,
  extractChangedFiles,
  stripTrailingExitCode,
  extractWorkLogItemType,
  extractWorkLogRequestKind,
} from "./work-log-command.ts";

describe("work log parsing", () => {
  it("extracts command text for command tool activities", () => {
    const entry = extractToolCommand({
      itemType: "command_execution",
      data: {
        item: {
          command: ["bun", "run", "lint"],
        },
      },
    });
    expect(entry?.command).toBe("bun run lint");
  });
  it("unwraps PowerShell command wrappers for displayed command text", () => {
    const entry = extractToolCommand({
      itemType: "command_execution",
      data: {
        item: {
          command: "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -Command 'bun run lint'",
        },
      },
    });
    expect(entry?.command).toBe("bun run lint");
    expect(entry?.rawCommand).toBe(
      "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -Command 'bun run lint'",
    );
  });
  it("unwraps PowerShell command wrappers from argv-style command payloads", () => {
    const entry = extractToolCommand({
      itemType: "command_execution",
      data: {
        item: {
          command: ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "-Command", "rg -n foo ."],
        },
      },
    });
    expect(entry?.command).toBe("rg -n foo .");
    expect(entry?.rawCommand).toBe(
      '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "rg -n foo ."',
    );
  });
  it("extracts command text from command detail when structured command metadata is missing", () => {
    const entry = extractToolCommand({
      itemType: "command_execution",
      detail:
        '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo -NoProfile -Command \'rg -n -F "new Date()" .\' <exited with exit code 0>',
    });
    expect(entry?.command).toBe('rg -n -F "new Date()" .');
    expect(entry?.rawCommand).toBe(
      `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo -NoProfile -Command 'rg -n -F "new Date()" .'`,
    );
  });
  it("does not unwrap shell commands when no wrapper flag is present", () => {
    const entry = extractToolCommand({
      itemType: "command_execution",
      data: {
        item: {
          command: "bash script.sh",
        },
      },
    });
    expect(entry?.command).toBe("bash script.sh");
    expect(entry?.rawCommand).toBeNull();
  });
  it("extracts changed file paths for file-change tool activities", () => {
    const entry = extractChangedFiles({
      itemType: "file_change",
      data: {
        item: {
          changes: [
            { path: "apps/web/src/components/ChatView.tsx" },
            { filename: "apps/web/src/session-logic.ts" },
          ],
        },
      },
    });
    expect(entry).toEqual([
      "apps/web/src/components/ChatView.tsx",
      "apps/web/src/session-logic.ts",
    ]);
  });
  it.each([
    ["bash -lc 'pwd'", "pwd"],
    ["/bin/sh -c 'echo hello'", "echo hello"],
    ["zsh -c 'pwd'", "pwd"],
    ["cmd.exe /C echo hello", "echo hello"],
    ["powershell -Command 'pwd'", "pwd"],
  ])("unwraps %s", (command, expected) => {
    expect(extractToolCommand({ data: { command } })).toEqual({
      command: expected,
      rawCommand: command,
    });
  });
  it("keeps candidate precedence and rejects empty or malformed commands", () => {
    expect(extractToolCommand(null)).toEqual({ command: null, rawCommand: null });
    expect(extractToolCommand({ data: { item: { command: [null, " ", 42] } } })).toEqual({
      command: null,
      rawCommand: null,
    });
    expect(
      extractToolCommand({
        data: {
          command: "fallback",
          item: { command: "first", input: { command: "second" }, result: { command: "third" } },
        },
      }).command,
    ).toBe("first");
    expect(
      extractToolCommand({
        data: { item: { input: { command: "second" }, result: { command: "third" } } },
      }).command,
    ).toBe("second");
    expect(extractToolCommand({ data: { item: { result: { command: "third" } } } }).command).toBe(
      "third",
    );
  });
  it("strips only a trailing numeric exit suffix", () => {
    expect(stripTrailingExitCode(" output <exited with exit code 12> ")).toEqual({
      output: "output",
      exitCode: 12,
    });
    expect(stripTrailingExitCode("<exited with exit code 0>")).toEqual({
      output: null,
      exitCode: 0,
    });
    expect(stripTrailingExitCode("<exited with exit code x>").output).toBe(
      "<exited with exit code x>",
    );
    expect(stripTrailingExitCode("  ")).toEqual({ output: null });
  });
  it("validates item and request kinds", () => {
    expect(extractWorkLogItemType({ itemType: "command_execution" })).toBe("command_execution");
    expect(extractWorkLogItemType({ itemType: "unknown" })).toBeUndefined();
    expect(extractWorkLogRequestKind({ requestKind: "file-read" })).toBe("file-read");
    expect(extractWorkLogRequestKind({ requestType: "command_execution_approval" })).toBe(
      "command",
    );
    expect(extractWorkLogRequestKind(null)).toBeUndefined();
  });
  it("deduplicates paths in traversal order and bounds depth and count", () => {
    expect(
      extractChangedFiles({
        data: {
          path: "a",
          filePath: "a",
          newPath: "b",
          oldPath: "c",
          files: [{ path: "b" }, { relativePath: "d" }],
        },
      }),
    ).toEqual(["a", "b", "c", "d"]);
    expect(
      extractChangedFiles({
        data: { data: { data: { data: { data: { path: "depth4", data: { path: "depth5" } } } } } },
      }),
    ).toEqual(["depth4"]);
    expect(
      extractChangedFiles({
        data: { files: Array.from({ length: 15 }, (_, i) => ({ path: String(i) })) },
      }),
    ).toHaveLength(12);
  });
});
