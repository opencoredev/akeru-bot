// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, it } from "@effect/vitest";

const root = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const guidance = [
  ".agents/skills/test-t3-app/SKILL.md",
  ".agents/skills/test-t3-app/references/sqlite-fixtures.md",
  ".agents/skills/test-t3-mobile/SKILL.md",
  ".agents/skills/ios-debugger-agent/SKILL.md",
  ".agents/skills/ios-simulator-browser/SKILL.md",
  "docs/internals/verification.md",
];

for (const relativePath of guidance) {
  it(`resolves local reference links in ${relativePath}`, () => {
    const filename = NodePath.join(root, relativePath);
    const content = NodeFS.readFileSync(filename, "utf8");
    const links = Array.from(content.matchAll(/\]\(([^)]+)\)/g), (match) => match[1]!);
    const localLinks = links.filter((link) => !/^(?:[a-z]+:|#)/i.test(link));
    for (const link of localLinks) {
      const target = NodePath.resolve(NodePath.dirname(filename), link.split("#")[0]!);
      assert.isTrue(NodeFS.existsSync(target), `${relativePath}: ${link}`);
    }
  });
}

it("keeps the worktree setup sequence connected to its implementation", () => {
  const config = JSON.parse(NodeFS.readFileSync(NodePath.join(root, "t3.json"), "utf8"));
  assert.deepEqual(
    config.scripts
      .filter((script: { runOnWorktreeCreate?: boolean }) => script.runOnWorktreeCreate)
      .map((script: { command: string }) => script.command),
    ["vp i && node scripts/setup-worktree-env.ts && node apps/web/scripts/warm-dep-cache.ts"],
  );
  assert.isTrue(NodeFS.existsSync(NodePath.join(root, "scripts/setup-worktree-env.ts")));
});
