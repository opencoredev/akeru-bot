import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { Options as ClaudeQueryOptions } from "@anthropic-ai/claude-agent-sdk";
import { BotId, ThreadId, type ProviderInstanceEnvironment } from "@akeru/contracts";
import { HostProcessPlatform } from "@akeru/shared/hostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { claudeChildHomeDirectory } from "../Layers/claude/ClaudeChildHome.ts";
import { FakeClaudeQuery } from "../Layers/test-support/claudeAdapterHarness.ts";
import {
  HOSTILE_SERVER_ENVIRONMENT,
  claudeCodeTestLayer,
  makeClaudeCodeAdapter,
  policyWith,
} from "../Layers/test-support/claudeCodeAdapterHarness.ts";
import {
  clearBotToolPermissionSession,
  setBotToolPermissionSession,
} from "../tools/BotToolPermissionSessions.ts";
import { CLAUDE_CODE_DRIVER_KIND } from "./ClaudeCodeLogin.ts";

const BOT_ID = BotId.make("bot-ada");

describe("claudeChildHomeDirectory", () => {
  it("reads USERPROFILE on Windows, whatever HOME says", () => {
    assert.equal(
      claudeChildHomeDirectory({ USERPROFILE: "C:\\Users\\ada" }, "win32"),
      "C:\\Users\\ada",
    );
    assert.equal(
      claudeChildHomeDirectory({ HOME: "C:\\other", USERPROFILE: "C:\\Users\\ada" }, "win32"),
      "C:\\Users\\ada",
    );
    assert.equal(
      claudeChildHomeDirectory({ USERPROFILE: "C:\\Users\\srv", UserProfile: "D:\\ada" }, "win32"),
      // Node's Windows spawn keeps the first spelling in sorted order, whatever the insertion order.
      "C:\\Users\\srv",
    );
    assert.equal(claudeChildHomeDirectory({ HOME: "C:\\other" }, "win32"), NodeOS.homedir());
  });

  it("reads HOME elsewhere, whatever USERPROFILE says", () => {
    assert.equal(claudeChildHomeDirectory({ HOME: "/home/ada" }, "linux"), "/home/ada");
    assert.equal(
      claudeChildHomeDirectory({ HOME: "/home/ada", USERPROFILE: "/home/other" }, "darwin"),
      "/home/ada",
    );
    assert.equal(
      claudeChildHomeDirectory({ USERPROFILE: "/home/other" }, "linux"),
      NodeOS.homedir(),
    );
    assert.equal(claudeChildHomeDirectory({ HOME: "  " }, "linux"), NodeOS.homedir());
  });
});

function makeFolder(prefix: string) {
  return NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix)));
}

/**
 * Starts a Full access session on `platform` and asks whether Claude Code may
 * read each path. The server's own HOME is a decoy folder, so a check that
 * falls back to it protects nothing the child uses.
 */
const readDecisions = (input: {
  readonly platform: NodeJS.Platform;
  readonly base: NodeJS.ProcessEnv;
  readonly instance: ProviderInstanceEnvironment;
  readonly assignedConfigDirectory?: string;
  readonly paths: ReadonlyArray<string>;
}) =>
  Effect.gen(function* () {
    const workspace = makeFolder("akeru-claude-home-workspace-");
    const fake = new FakeClaudeQuery();
    let options: ClaudeQueryOptions | undefined;

    const adapter = yield* makeClaudeCodeAdapter(
      (query) => {
        options = query.options;

        return fake;
      },
      {
        base: input.base,
        instance: input.instance,
        ...(input.assignedConfigDirectory
          ? { assignedConfigDirectory: input.assignedConfigDirectory }
          : {}),
      },
    );

    const threadId = ThreadId.make(`thread-claude-home-${NodePath.basename(workspace)}`);
    const policy = policyWith({});

    setBotToolPermissionSession(threadId, {
      botId: BOT_ID,
      permissions: {
        principal: { kind: "owner" },
        policy,
        readPolicy: async () => policy,
      },
    });

    yield* adapter.startSession({
      threadId,
      provider: CLAUDE_CODE_DRIVER_KIND,
      runtimeMode: "full-access",
      botId: BOT_ID,
      cwd: workspace,
    });

    const canUseTool = options?.canUseTool;

    if (!canUseTool) throw new Error("The session has no permission callback.");

    const decisions = yield* Effect.forEach(input.paths, (file_path, index) =>
      Effect.promise(() =>
        canUseTool(
          "Read",
          { file_path },
          { signal: new AbortController().signal, toolUseID: `home-${index}` },
        ),
      ).pipe(Effect.map((result) => result.behavior)),
    );

    clearBotToolPermissionSession(threadId);
    yield* adapter.stopSession(threadId);

    return decisions;
  }).pipe(Effect.provideService(HostProcessPlatform, input.platform));

describe("Claude Code login policy on the child's home folder", () => {
  it.effect("protects USERPROFILE on Windows when the account sets only USERPROFILE", () =>
    Effect.gen(function* () {
      const home = makeFolder("akeru-claude-home-");
      const decoy = makeFolder("akeru-claude-decoy-");

      const decisions = yield* readDecisions({
        platform: "win32",
        base: { ...HOSTILE_SERVER_ENVIRONMENT, HOME: decoy, USERPROFILE: decoy },
        instance: [{ name: "USERPROFILE", value: home, sensitive: false }],
        paths: [
          NodePath.join(home, ".claude.json"),
          NodePath.join(home, ".claude", ".credentials.json"),
        ],
      });

      assert.deepEqual(decisions, ["deny", "deny"]);
    }).pipe(Effect.provide(claudeCodeTestLayer)),
  );

  it.effect("lets the account's own UserProfile replace an inherited USERPROFILE on Windows", () =>
    Effect.gen(function* () {
      const home = makeFolder("akeru-claude-home-");
      const decoy = makeFolder("akeru-claude-decoy-");

      // The server inherited one spelling and the account set another; the account's wins.
      const decisions = yield* readDecisions({
        platform: "win32",
        base: { ...HOSTILE_SERVER_ENVIRONMENT, USERPROFILE: decoy },
        instance: [{ name: "UserProfile", value: home, sensitive: false }],
        paths: [NodePath.join(home, ".claude.json")],
      });

      assert.deepEqual(decisions, ["deny"]);
    }).pipe(Effect.provide(claudeCodeTestLayer)),
  );

  it.effect("protects USERPROFILE on Windows when the account sets only HOME", () =>
    Effect.gen(function* () {
      const home = makeFolder("akeru-claude-home-");
      const decoy = makeFolder("akeru-claude-decoy-");

      const decisions = yield* readDecisions({
        platform: "win32",
        base: { ...HOSTILE_SERVER_ENVIRONMENT, HOME: decoy, USERPROFILE: home },
        instance: [{ name: "HOME", value: decoy, sensitive: false }],
        paths: [NodePath.join(home, ".claude.json")],
      });

      assert.deepEqual(decisions, ["deny"]);
    }).pipe(Effect.provide(claudeCodeTestLayer)),
  );

  it.effect("protects USERPROFILE on Windows when the account sets both", () =>
    Effect.gen(function* () {
      const home = makeFolder("akeru-claude-home-");
      const decoy = makeFolder("akeru-claude-decoy-");

      const decisions = yield* readDecisions({
        platform: "win32",
        base: { ...HOSTILE_SERVER_ENVIRONMENT, HOME: decoy },
        instance: [
          { name: "HOME", value: decoy, sensitive: false },
          { name: "USERPROFILE", value: home, sensitive: false },
          // `~` in the account's config folder means the same home.
          { name: "CLAUDE_CONFIG_DIR", value: "~/claude-work", sensitive: false },
        ],
        paths: [
          NodePath.join(home, ".claude.json"),
          NodePath.join(home, "claude-work", "settings.json"),
        ],
      });

      assert.deepEqual(decisions, ["deny", "deny"]);
    }).pipe(Effect.provide(claudeCodeTestLayer)),
  );

  it.effect("protects HOME elsewhere when the account sets HOME", () =>
    Effect.gen(function* () {
      const home = makeFolder("akeru-claude-home-");
      const decoy = makeFolder("akeru-claude-decoy-");

      const decisions = yield* readDecisions({
        platform: "linux",
        base: { ...HOSTILE_SERVER_ENVIRONMENT, HOME: decoy },
        instance: [
          { name: "HOME", value: home, sensitive: false },
          { name: "USERPROFILE", value: decoy, sensitive: false },
        ],
        paths: [NodePath.join(home, ".claude.json")],
      });

      assert.deepEqual(decisions, ["deny"]);
    }).pipe(Effect.provide(claudeCodeTestLayer)),
  );

  it.effect("keeps the assigned per-account config folder protected", () =>
    Effect.gen(function* () {
      const home = makeFolder("akeru-claude-home-");
      const assigned = makeFolder("akeru-claude-assigned-");

      const decisions = yield* readDecisions({
        platform: "win32",
        base: { ...HOSTILE_SERVER_ENVIRONMENT, HOME: home },
        instance: [{ name: "USERPROFILE", value: home, sensitive: false }],
        assignedConfigDirectory: assigned,
        paths: [NodePath.join(assigned, ".credentials.json"), NodePath.join(home, ".claude.json")],
      });

      assert.deepEqual(decisions, ["deny", "deny"]);
    }).pipe(Effect.provide(claudeCodeTestLayer)),
  );
});
