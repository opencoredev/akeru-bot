import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { SdkRecord } from "../Layers/ProtocolJson.ts";
import {
  claudeCodeToolPathReach,
  hostPathsAreCaseInsensitive,
  mcpPathArgument,
  type ClaudeCodeFileScope,
} from "./ClaudeCodeToolPaths.ts";

/** A fake home with a workspace, a private folder, and Claude Code's own files. */
function makeHome() {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-claude-paths-")),
  );

  const workspace = NodePath.join(root, "work", "project");
  const attachments = NodePath.join(root, "akeru", "attachments");
  const documents = NodePath.join(root, "Documents");
  const configDirectory = NodePath.join(root, ".claude-work");

  for (const directory of [workspace, attachments, documents, NodePath.join(root, ".claude")]) {
    NodeFS.mkdirSync(directory, { recursive: true });
  }

  NodeFS.writeFileSync(NodePath.join(documents, "private.txt"), "secret");
  NodeFS.symlinkSync(documents, NodePath.join(workspace, "docs-link"));

  const scope: ClaudeCodeFileScope = {
    cwd: workspace,
    readRoots: [attachments],
    homeDirectory: root,
    claudeConfigDirectory: configDirectory,
    caseInsensitivePaths: false,
  };

  return { root, workspace, attachments, documents, configDirectory, scope };
}

const reach = (toolName: string, input: SdkRecord, scope: ClaudeCodeFileScope) =>
  claudeCodeToolPathReach(toolName, input, scope).pipe(Effect.provide(NodeServices.layer));

describe("claudeCodeToolPathReach", () => {
  it.effect("keeps workspace and attachment paths inside", () =>
    Effect.gen(function* () {
      const home = makeHome();

      assert.equal(yield* reach("Read", { file_path: "src/index.ts" }, home.scope), "inside");
      assert.equal(
        yield* reach("Edit", { file_path: NodePath.join(home.workspace, "a.ts") }, home.scope),
        "inside",
      );
      assert.equal(
        yield* reach("Read", { file_path: NodePath.join(home.attachments, "a.png") }, home.scope),
        "inside",
      );
      assert.equal(yield* reach("Grep", { pattern: "TODO" }, home.scope), "inside");
    }),
  );

  it.effect("puts reads and writes elsewhere on the machine outside", () =>
    Effect.gen(function* () {
      const home = makeHome();

      assert.equal(
        yield* reach(
          "Read",
          { file_path: NodePath.join(home.documents, "private.txt") },
          home.scope,
        ),
        "outside",
      );
      assert.equal(yield* reach("Write", { file_path: "~/.bashrc" }, home.scope), "outside");
      assert.equal(
        yield* reach("Write", { file_path: NodePath.join(home.attachments, "a.png") }, home.scope),
        "outside",
      );
      assert.equal(yield* reach("Glob", { pattern: "/etc/**/*.conf" }, home.scope), "outside");
      assert.equal(yield* reach("LS", { path: home.root }, home.scope), "outside");
    }),
  );

  it.effect("normalizes .. and follows symlinks out of the workspace", () =>
    Effect.gen(function* () {
      const home = makeHome();

      assert.equal(
        yield* reach("Read", { file_path: "../../Documents/private.txt" }, home.scope),
        "outside",
      );
      assert.equal(
        yield* reach("Read", { file_path: "docs-link/private.txt" }, home.scope),
        "outside",
      );
      assert.equal(
        yield* reach("Write", { file_path: "docs-link/new-file.txt" }, home.scope),
        "outside",
      );
    }),
  );

  it.effect("flags Claude Code's own login and settings, however they are named", () =>
    Effect.gen(function* () {
      const home = makeHome();

      for (const [toolName, input] of [
        ["Read", { file_path: "~/.claude/.credentials.json" }],
        ["Read", { file_path: NodePath.join(home.root, ".claude.json") }],
        ["Edit", { file_path: NodePath.join(home.configDirectory, "settings.json") }],
        ["Grep", { pattern: "token", path: "~/.claude" }],
        ["Read", { file_path: "../../.claude/.credentials.json" }],
      ] as const) {
        assert.equal(yield* reach(toolName, input, home.scope), "claude-config", toolName);
      }
    }),
  );

  it.effect("matches Claude Code's files in any letter case on a case-insensitive host", () =>
    Effect.gen(function* () {
      const home = makeHome();
      const insensitive = { ...home.scope, caseInsensitivePaths: true };

      const calls = [
        ["Read", { file_path: NodePath.join(home.root, ".CLAUDE.JSON") }],
        ["Read", { file_path: "~/.Claude/.credentials.json" }],
        ["Edit", { file_path: NodePath.join(home.root, ".CLAUDE-WORK", "settings.json") }],
        ["Grep", { pattern: "token", path: home.root.toUpperCase() }],
      ] as const;

      for (const [toolName, input] of calls) {
        assert.equal(yield* reach(toolName, input, insensitive), "claude-config", toolName);
      }

      assert.equal(
        yield* reach("Bash", { command: "cat ~/.CLAUDE.JSON" }, insensitive),
        "claude-config-shell",
      );

      // A case-sensitive host keeps those names apart, so `.CLAUDE.JSON` is another file.
      assert.equal(yield* reach(...calls[0], home.scope), "outside");
      assert.deepEqual(
        (["win32", "darwin", "linux"] as const).map((platform) =>
          hostPathsAreCaseInsensitive(platform),
        ),
        [true, true, false],
      );
    }),
  );

  it.effect("flags recursive searches whose root holds Claude Code's files", () =>
    Effect.gen(function* () {
      const home = makeHome();
      NodeFS.mkdirSync(home.configDirectory);
      NodeFS.writeFileSync(NodePath.join(home.configDirectory, "settings.json"), "{}");

      for (const [toolName, input] of [
        ["Grep", { pattern: ".", path: home.root, output_mode: "content" }],
        ["Grep", { pattern: ".", path: "~" }],
        ["Grep", { pattern: ".", path: "/" }],
        ["Glob", { pattern: "**/*.json", path: home.root }],
        ["Glob", { pattern: `${home.root}/**/settings.json` }],
      ] as const) {
        assert.equal(
          yield* reach(toolName, input, home.scope),
          "claude-config",
          JSON.stringify(input),
        );
      }

      // A search with no path walks the workspace, so a home-folder workspace counts too.
      assert.equal(
        yield* reach("Grep", { pattern: "." }, { ...home.scope, cwd: home.root }),
        "claude-config",
      );

      // A sibling folder, and a plain listing of the home folder, stay ordinary reads.
      assert.equal(
        yield* reach("Grep", { pattern: ".", path: home.documents }, home.scope),
        "outside",
      );
      assert.equal(yield* reach("LS", { path: home.root }, home.scope), "outside");
    }),
  );

  it.effect("flags shell commands that may reach Claude Code's files, however they spell it", () =>
    Effect.gen(function* () {
      const home = makeHome();

      for (const command of [
        "cat ~/.claude/.credentials.json",
        'cat "$HOME"/.claude/.credentials.json',
        "cat ${HOME}/.claude.json",
        "cd ~ && cat .claude/.credentials.json",
        "cd $HOME; ls -a",
        "pushd ~ >/dev/null && tar czf /tmp/x.tgz .",
        "find / -name '.credentials*'",
        `cat ${home.configDirectory}/settings.json`,
        "cd /tmp && cat ../home/u/.claude-work/settings.json",
        "echo $CLAUDE_CONFIG_DIR",
      ]) {
        assert.equal(yield* reach("Bash", { command }, home.scope), "claude-config-shell", command);
      }

      for (const command of ["ls -la", "cat ~/notes.txt", "cd src && npm test"]) {
        assert.equal(yield* reach("Bash", { command }, home.scope), "inside", command);
      }
    }),
  );

  it.effect("never treats a dangling or unresolvable symlink as inside", () =>
    Effect.gen(function* () {
      const home = makeHome();

      // A dangling link pointing out of the workspace, as a write target.
      NodeFS.symlinkSync(
        NodePath.join(home.documents, "not-yet-there.txt"),
        NodePath.join(home.workspace, "dangling-out"),
      );

      // A dangling link into Claude Code's own folder.
      NodeFS.symlinkSync(
        NodePath.join(home.root, ".claude", "new-settings.json"),
        NodePath.join(home.workspace, "dangling-config"),
      );

      // A link loop cannot be resolved at all.
      NodeFS.symlinkSync(
        NodePath.join(home.workspace, "loop-b"),
        NodePath.join(home.workspace, "loop-a"),
      );
      NodeFS.symlinkSync(
        NodePath.join(home.workspace, "loop-a"),
        NodePath.join(home.workspace, "loop-b"),
      );

      assert.equal(yield* reach("Write", { file_path: "dangling-out" }, home.scope), "outside");
      assert.equal(
        yield* reach("Write", { file_path: "dangling-config" }, home.scope),
        "claude-config",
      );
      assert.equal(yield* reach("Read", { file_path: "loop-a/file" }, home.scope), "outside");

      // A dangling link that stays in the workspace is still inside.
      NodeFS.symlinkSync(
        NodePath.join(home.workspace, "later.txt"),
        NodePath.join(home.workspace, "dangling-in"),
      );
      assert.equal(yield* reach("Write", { file_path: "dangling-in" }, home.scope), "inside");
    }),
  );

  it.effect("checks path arguments of MCP tools, including file URIs", () =>
    Effect.gen(function* () {
      const home = makeHome();
      const credentials = NodePath.join(home.root, ".claude", ".credentials.json");

      for (const input of [
        { path: credentials },
        { paths: ["src/a.ts", credentials] },
        { source: "~/.claude/settings.json", destination: "copy.json" },
        { uri: `file://${credentials}` },
        { uri: `file://${home.root}/%2Eclaude/.credentials.json` },
        { filename: NodePath.join(home.root, ".claude.json") },
      ]) {
        assert.equal(
          yield* reach("mcp__filesystem__read_file", input, home.scope),
          "claude-config",
          JSON.stringify(input),
        );
      }

      assert.equal(
        yield* reach("mcp__filesystem__read_file", { path: "src/a.ts" }, home.scope),
        "inside",
      );
      assert.equal(
        yield* reach("mcp__web__fetch", { url: "https://example.com/.claude" }, home.scope),
        "inside",
      );
    }),
  );

  it.effect("decodes every escape in a file URL, so an accented home is still protected", () =>
    Effect.gen(function* () {
      const home = makeHome();
      const accented = NodePath.join(home.root, "José");
      NodeFS.mkdirSync(NodePath.join(accented, ".claude"), { recursive: true });
      const scope = { ...home.scope, homeDirectory: accented };
      const credentials = NodePath.join(accented, ".claude", ".credentials.json");
      const url = NodeURL.pathToFileURL(credentials).href;

      assert.include(url, "Jos%C3%A9");
      assert.equal(
        yield* reach("mcp__filesystem__read_file", { uri: url }, scope),
        "claude-config",
      );
    }),
  );

  it.effect("treats a file URL that names no path on this host as protected", () =>
    Effect.gen(function* () {
      const home = makeHome();

      for (const uri of [
        "file://server/share/.claude/.credentials.json",
        `file://${home.root}/.claude%2F.credentials.json`,
        "file://[not-a-host]/x",
      ]) {
        assert.equal(
          yield* reach("mcp__filesystem__read_file", { uri }, home.scope),
          "claude-config",
          uri,
        );
      }
    }),
  );

  it.effect("puts relative paths outside when the chat has no workspace", () =>
    Effect.gen(function* () {
      const home = makeHome();

      assert.equal(
        yield* reach("Read", { file_path: "notes.txt" }, { ...home.scope, cwd: undefined }),
        "outside",
      );
    }),
  );

  it.effect("resolves a symlink before the .. that follows it, as the OS does", () =>
    Effect.gen(function* () {
      const home = makeHome();
      const claudeFolder = NodePath.join(home.root, ".claude");
      const credentials = NodePath.join(claudeFolder, ".credentials.json");

      NodeFS.mkdirSync(NodePath.join(claudeFolder, "child"));
      NodeFS.writeFileSync(credentials, "{}");
      NodeFS.symlinkSync(
        NodePath.join(claudeFolder, "child"),
        NodePath.join(home.workspace, "gate"),
      );
      NodeFS.symlinkSync("gate/../.credentials.json", NodePath.join(home.workspace, "innocent"));

      // The premise: the OS really lands on Claude Code's credentials. The
      // native call asks the OS; Node's own realpath folds `..` too early.
      assert.equal(
        NodeFS.realpathSync.native(NodePath.join(home.workspace, "innocent")),
        credentials,
      );
      assert.equal(NodeFS.readFileSync(NodePath.join(home.workspace, "innocent"), "utf8"), "{}");

      assert.equal(yield* reach("Read", { file_path: "innocent" }, home.scope), "claude-config");
      assert.equal(
        yield* reach("Read", { file_path: "gate/../.credentials.json" }, home.scope),
        "claude-config",
      );
      assert.equal(
        yield* reach(
          "Write",
          // Built by hand: NodePath.join would fold the `..` away before the check.
          { file_path: `${home.workspace}/gate/../settings.json` },
          home.scope,
        ),
        "claude-config",
      );

      // A plain .. inside the workspace stays inside.
      NodeFS.mkdirSync(NodePath.join(home.workspace, "src"));
      assert.equal(yield* reach("Read", { file_path: "src/../README.md" }, home.scope), "inside");
    }),
  );

  it.effect(
    "lets ordinary folder changes follow the policy and asks for home or unknown ones",
    () =>
      Effect.gen(function* () {
        const home = makeHome();

        for (const command of [
          "cd ~/projects/x && npm test",
          'cd "$HOME/projects/x" && npm test',
          "cd ${HOME}/work/app; make",
          "cd src && cat ~/notes.txt",
          "pushd ~/work && git status",
          "cd .. && ls",
          "cd -P build && ls",
        ]) {
          assert.equal(yield* reach("Bash", { command }, home.scope), "inside", command);
        }

        for (const command of [
          "cd && cat notes",
          "cd ~ && ls -a",
          'cd "$HOME" && ls -a',
          "cd ${HOME}; ls -a",
          "cd ~/ && ls",
          "ls; cd",
          "cd - && cat config.json",
          "cd $(git rev-parse --show-toplevel)/.. && ls",
          "cd $SOMEWHERE && ls",
          "cd ~/.claude && ls",
          "cd ~/projects && cat .credentials.json",
          "echo $CLAUDE_CONFIG_DIR",
          "cat ../.claude-work/settings.json",
        ]) {
          assert.equal(
            yield* reach("Bash", { command }, home.scope),
            "claude-config-shell",
            command,
          );
        }
      }),
  );
});

describe("mcpPathArgument", () => {
  it("converts Windows drive and UNC file URLs the way Windows opens them", () => {
    assert.deepEqual(
      mcpPathArgument("uri", "file:///C:/Users/Jos%C3%A9/.claude/.credentials.json", {
        windows: true,
      }),
      { kind: "path", path: "C:\\Users\\José\\.claude\\.credentials.json" },
    );
    assert.deepEqual(
      mcpPathArgument("uri", "file://server/share/.claude/.credentials.json", { windows: true }),
      { kind: "path", path: "\\\\server\\share\\.claude\\.credentials.json" },
    );
  });

  it("marks a file URL that cannot be converted, and ignores other URLs", () => {
    assert.deepEqual(mcpPathArgument("uri", "file://server/share/x", { windows: false }), {
      kind: "unconvertible",
    });
    assert.deepEqual(mcpPathArgument("uri", "file:///a%2Fb", { windows: false }), {
      kind: "unconvertible",
    });
    assert.deepEqual(mcpPathArgument("url", "https://example.com/.claude", { windows: false }), {
      kind: "none",
    });
  });
});
