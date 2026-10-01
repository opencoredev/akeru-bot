import {
  ClaudeTextGenerationTestLayer,
  withFakeClaudeEnv,
} from "./testUtils/claudeTextGeneration.ts";
import { it } from "@effect/vitest";
import { ProviderInstanceId } from "@akeru/contracts";
import { createModelSelection } from "@akeru/shared/model";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { expect } from "vite-plus/test";
import { sanitizeThreadTitle } from "./TextGenerationUtils.ts";
it.layer(ClaudeTextGenerationTestLayer)("ClaudeTextGeneration", (it) => {
  it.effect("forwards Claude thinking settings for Haiku without passing effort", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title: "Add important change",
          },
        }),
        argsMustContain: '--settings {"disableAllHooks":true,"alwaysThinkingEnabled":false}',
        argsMustNotContain: "--effort",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Add important change",
            modelSelection: {
              ...createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-haiku-4-5", [
                { id: "thinking", value: false },
                { id: "effort", value: "high" },
              ]),
            },
          });

          expect(generated.title).toBe("Add important change");
        }),
    ),
  );

  it.effect("forwards Claude fast mode and supported effort", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title: "Improve orchestration flow",
            body: "Body",
          },
        }),
        argsMustContain: '--effort max --settings {"disableAllHooks":true,"fastMode":true}',
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Add important change",
            modelSelection: {
              ...createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-opus-4-6", [
                { id: "effort", value: "max" },
                { id: "fastMode", value: true },
              ]),
            },
          });

          expect(generated.title).toBe("Improve orchestration flow");
        }),
    ),
  );

  it.effect(
    "generates thread titles outside the project with tools, skills, and hooks disabled",
    () =>
      withFakeClaudeEnv(
        {
          output: JSON.stringify({
            structured_output: {
              title:
                '  "Reconnect failures after restart because the session state does not recover"  ',
            },
          }),
          cwdMustNotBe: process.cwd(),
          stdinMustContain: "/call-script",
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "/call-script",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: "claude-sonnet-4-6",
              },
            });

            expect(generated.title).toBe(
              sanitizeThreadTitle(
                '"Reconnect failures after restart because the session state does not recover"',
              ),
            );
          }),
      ),
  );

  it.effect("generates branch names from skill prompts without executable capabilities", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({ structured_output: { branch: "call-script" } }),
        stdinMustContain: "/call-script",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateBranchName({
            cwd: process.cwd(),
            message: "/call-script",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-sonnet-4-6",
            },
          });

          expect(generated.branch).toBe("call-script");
        }),
    ),
  );

  it.effect("runs Claude text generation with the configured CLAUDE_CONFIG_DIR", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const claudeConfigDir = path.join(process.cwd(), ".claude-work-test");
      return yield* withFakeClaudeEnv(
        {
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          output: JSON.stringify({
            structured_output: {
              title: "Use Claude home",
            },
          }),
          configDirMustBe: claudeConfigDir,
          claudeConfig: { homePath: claudeConfigDir },
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "thread title",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: "claude-sonnet-4-6",
              },
            });

            expect(generated.title).toBe(sanitizeThreadTitle("Use Claude home"));
          }),
      );
    }),
  );

  for (const verbose of [false, true]) {
    it.effect(`unwraps a JSON title in ${verbose ? "verbose" : "normal"} Claude output`, () => {
      const result = {
        type: "result",
        structured_output: { title: '{"title": "Refresh ev-stg APP ASG instances"}' },
      };
      return withFakeClaudeEnv(
        { output: JSON.stringify(verbose ? [result] : result) },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "Refresh ev-stg APP ASG instances",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: "claude-sonnet-4-6",
              },
            });

            expect(generated.title).toBe("Refresh ev-stg APP ASG instances");
          }),
      );
    });
  }

  for (const previousTitle of [undefined, "Old thread title"]) {
    it.effect(
      `reads the result from verbose Claude output when ${previousTitle ? "regenerating" : "generating"} a title`,
      () =>
        withFakeClaudeEnv(
          {
            output: JSON.stringify([
              { type: "system", subtype: "init" },
              { type: "assistant", message: { content: [] } },
              { type: "user", message: { content: [] } },
              { type: "rate_limit_event" },
              {
                type: "result",
                subtype: "success",
                result: '{"title":"Refresh ev-stg APP ASG Instances"}',
                structured_output: { title: "Refresh ev-stg APP ASG Instances" },
              },
            ]),
          },
          (textGeneration) =>
            Effect.gen(function* () {
              const generated = yield* textGeneration.generateThreadTitle({
                cwd: process.cwd(),
                message: "Refresh ev-stg APP ASG instances",
                previousTitle,
                modelSelection: {
                  instanceId: ProviderInstanceId.make("claudeAgent"),
                  model: "claude-sonnet-4-6",
                },
              });

              expect(generated.title).toBe("Refresh ev-stg APP ASG Instances");
            }),
        ),
    );
  }

  for (const [name, output] of [
    ["empty message array", []],
    ["missing result", [{ type: "assistant", structured_output: { title: "Not a result" } }]],
    ["invalid title", [{ type: "result", structured_output: { title: 42 } }]],
    [
      "final result without structured output",
      [
        { type: "result", structured_output: { title: "Earlier result" } },
        { type: "result", subtype: "error_max_structured_output_retries" },
      ],
    ],
  ] as const) {
    it.effect(`rejects verbose Claude output with ${name}`, () =>
      withFakeClaudeEnv({ output: JSON.stringify(output) }, (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "Name this thread",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: "claude-sonnet-4-6",
              },
            }),
          );

          expect(error._tag).toBe("TextGenerationError");
        }),
      ),
    );
  }

  it.effect("falls back when Claude thread title normalization becomes whitespace-only", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title: '  """   """  ',
          },
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread.",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-sonnet-4-6",
            },
          });

          expect(generated.title).toBe("New chat");
        }),
    ),
  );
});
