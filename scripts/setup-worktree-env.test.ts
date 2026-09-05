// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import { setupWorktreeEnv } from "./setup-worktree-env.ts";

function fixture(run: (root: string, worktree: string) => void) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-setup-"));
  const worktree = NodePath.join(root, "worktree with spaces");
  NodeFS.mkdirSync(worktree);
  try {
    run(root, worktree);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}

it("copies private configuration without sharing later writes", () => {
  fixture((root, worktree) => {
    NodeFS.writeFileSync(NodePath.join(root, ".env"), "EXAMPLE=initial\n");
    setupWorktreeEnv(worktree, root);
    const destination = NodePath.join(worktree, ".env");
    assert.isFalse(NodeFS.lstatSync(destination).isSymbolicLink());
    NodeFS.writeFileSync(destination, "EXAMPLE=local\n");
    setupWorktreeEnv(worktree, root);
    assert.equal(NodeFS.readFileSync(destination, "utf8"), "EXAMPLE=local\n");
    assert.equal(NodeFS.readFileSync(NodePath.join(root, ".env"), "utf8"), "EXAMPLE=initial\n");
  });
});

it("accepts missing optional source configuration", () => {
  fixture((root, worktree) => {
    assert.include(setupWorktreeEnv(worktree, undefined), "skipped");
    assert.include(setupWorktreeEnv(worktree, root), "skipped");
    assert.isFalse(NodeFS.existsSync(NodePath.join(worktree, ".env")));
  });
});

it("refuses existing symlinks without modifying their target", () => {
  fixture((root, worktree) => {
    const source = NodePath.join(root, ".env");
    NodeFS.writeFileSync(source, "EXAMPLE=shared\n");
    NodeFS.symlinkSync(source, NodePath.join(worktree, ".env"));
    assert.throws(() => setupWorktreeEnv(worktree, root), "symlink");
    assert.equal(NodeFS.readFileSync(source, "utf8"), "EXAMPLE=shared\n");
  });
});

it("refuses a directory instead of an environment file", () => {
  fixture((root, worktree) => {
    NodeFS.mkdirSync(NodePath.join(worktree, ".env"));
    assert.throws(() => setupWorktreeEnv(worktree, root), "regular file");
  });
});
