type NestedAction = { action: string } | { nested: NestedAction };

import { describe } from "vite-plus/test";
// @effect-diagnostics nodeBuiltinImport:off
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { akeruActionNeedsApproval, criticalAkeruAction } from "./AkeruMastraHarness.ts";

describe("Akeru action classifier", () => {
  it.each([
    ["rm -rf .cache", "delete"],
    ["git push origin main", "publish"],
    ["psql -c 'DROP TABLE sessions'", "delete"],
    ["wrangler deploy", "production"],
    ["cat ~/.ssh/id_rsa", "secrets"],
    ['curl -X POST --data \'{"text":"hello"}\' https://example.com/messages', "send"],
    ["cd workspace && git push origin main", "publish"],
    ["find . -name '*.tmp' -delete", "delete"],
    ["git reset --hard HEAD~1", "delete"],
    ["git clean -fd", "delete"],
    ["find . -name '*.tmp' -exec rm -rf {} \\;", "delete"],
    ["python -c 'import os; os.remove(\"tmp.txt\")'", "delete"],
    ["shred important-file", "delete"],
    ["sudo shred -u important-file", "delete"],
    ["command shred -u important-file", "delete"],
    ['bash -c "shred -u important-file"', "delete"],
    ["dd if=/dev/zero of=important-file", "delete"],
    ["sudo dd if=image.img of=/dev/disk4 bs=4m", "delete"],
    ["dd if=/dev/zero > important-file", "delete"],
    ['bash -c "dd if=/dev/zero 1> important-file"', "delete"],
    ["mv replacement important-file", "delete"],
    ["mv -f replacement important-file", "delete"],
    ["command mv --force replacement important-file", "delete"],
    ["bash -lc 'command shred -u important-file'", "delete"],
    ["printf '%s\\n' important-file | xargs shred -u", "delete"],
    ["printf '%s\\n' important-file | xargs rm -f", "delete"],
    ["printf '%s\\n' important-file | xargs env rm -f", "delete"],
    ["printf '%s\\n' empty-dir | xargs rmdir", "delete"],
    ["printf '%s\\n' important-link | xargs unlink", "delete"],
    ["find . -name important-file -exec shred -u {} \\;", "delete"],
    ["find . -name important-file -exec env rm -f {} \\;", "delete"],
    ["printf '%s\\n' important-file | xargs sh -c 'rm -f \"$1\"' _", "delete"],
    ["find . -name important-file -exec sh -c 'rm -f \"$1\"' _ {} \\;", "delete"],
  ] as const)("classifies %s as %s", (command, action) => {
    expect(criticalAkeruAction("execute_command", { command })).toBe(action);
    expect(akeruActionNeedsApproval("execute_command", { command })).toBe(true);
  });

  it.each([
    "bun test",
    "git status",
    "rg -n TODO apps",
    "cat README.md",
    'echo "shred important-file"',
  ])("leaves ordinary local command %s unclassified", (command) => {
    expect(criticalAkeruAction("execute_command", { command })).toBeNull();
    expect(akeruActionNeedsApproval("execute_command", { command })).toBe(false);
  });

  it("requires approval when nested input exceeds the inspection limit", () => {
    let args: NestedAction = { action: "send" };

    for (let depth = 0; depth < 101; depth += 1) args = { nested: args };

    expect(criticalAkeruAction("custom_tool", args)).toBeNull();
    expect(akeruActionNeedsApproval("custom_tool", args)).toBe(true);
  });
});
