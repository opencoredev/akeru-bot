import * as Predicate from "effect/Predicate";
import * as NodePath from "node:path";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, TextGenerationError } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { beforeEach, vi } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import { makeHarnessTextGeneration } from "./HarnessTextGeneration.ts";
import * as Harness from "../provider/AkeruMastraHarness.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";

const { generate, agents } = vi.hoisted(() => ({ generate: vi.fn(), agents: vi.fn() }));

vi.mock("@mastra/core/agent", () => ({
  Agent: class {
    constructor(options: ConstructorParameters<typeof import("@mastra/core/agent").Agent>[0]) {
      agents(options);
    }
    generate = generate;
  },
}));

beforeEach(() => {
  vi.restoreAllMocks();
  generate.mockReset();
  agents.mockReset();
});

describe("HarnessTextGeneration", () => {
  for (const operation of ["generateThreadTitle", "generateBranchName"] as const) {
    it.effect(`bounds ${operation} to 180 seconds and aborts generation`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const config = yield* ServerConfig;
          const instanceId = ProviderInstanceId.make("codex");

          const writer = yield* makeHarnessTextGeneration({
            secretsDir: config.secretsDir,
            driver: ProviderDriverKind.make("codex"),
            instanceId,
            connection: {
              environment: { OPENAI_API_KEY: "test-key" },
              instanceEnvironment: {},
              useSavedCredential: true,
            },
          });

          const started = Promise.withResolvers<AbortSignal>();
          generate.mockImplementationOnce((_message, options) => {
            started.resolve(options.abortSignal);

            return new Promise(() => {});
          });

          const input = {
            cwd: config.cwd,
            message: "Fix this",
            modelSelection: { instanceId, model: "gpt-6-sol" },
          };

          const request =
            operation === "generateThreadTitle"
              ? writer.generateThreadTitle(input).pipe(Effect.asVoid)
              : writer.generateBranchName(input).pipe(Effect.asVoid);

          const fiber = yield* request.pipe(
            Effect.flip,
            Effect.forkChild({ startImmediately: true }),
          );

          const signal = yield* Effect.tryPromise({
            try: () => started.promise,
            catch: (cause) =>
              new TextGenerationError({ operation, detail: "Generation did not start.", cause }),
          });

          yield* TestClock.adjust("180 seconds");
          expect(yield* Fiber.join(fiber)).toMatchObject({
            _tag: "TextGenerationError",
            operation,
            detail: "Akeru writing request timed out.",
          });
          expect(signal.aborted).toBe(true);
        }),
      ).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "akeru-writing-timeout-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );
  }

  it.effect("preserves Claude's selected 1M context window for titles and branches", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const instanceId = ProviderInstanceId.make("claudeAgent");

        const writer = yield* makeHarnessTextGeneration({
          secretsDir: config.secretsDir,
          driver: ProviderDriverKind.make("claudeAgent"),
          instanceId,
          connection: {
            environment: { ANTHROPIC_API_KEY: "test-key" },
            instanceEnvironment: {},
            useSavedCredential: true,
          },
        });

        const request = {
          cwd: config.cwd,
          message: "Fix this",
          modelSelection: {
            instanceId,
            model: "claude-opus-4-6",
            options: [
              { id: "contextWindow", value: "1m" },
              { id: "effort", value: "max" },
            ],
          },
        };

        generate.mockResolvedValueOnce({ text: '{"title":"Fix This"}' });
        yield* writer.generateThreadTitle(request);
        generate.mockResolvedValueOnce({ text: '{"branch":"fix-this"}' });
        yield* writer.generateBranchName(request);
        expect(agents.mock.calls.map((call) => call[0].model.modelId)).toEqual([
          "claude-opus-4-6",
          "claude-opus-4-6",
        ]);
        expect(generate.mock.calls.map((call) => call[1].providerOptions)).toEqual([
          { anthropic: { effort: "max" } },
          { anthropic: { effort: "max" } },
        ]);
      }),
    ).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "akeru-writing-claude-context-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("falls back to text when screenshots are missing or have invalid paths", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const instanceId = ProviderInstanceId.make("codex");

        const writer = yield* makeHarnessTextGeneration({
          secretsDir: config.secretsDir,
          driver: ProviderDriverKind.make("codex"),
          instanceId,
          connection: {
            environment: { OPENAI_API_KEY: "test-key" },
            instanceEnvironment: {},
            useSavedCredential: true,
          },
        });

        const request = {
          cwd: config.cwd,
          message: "Fix this",
          modelSelection: { instanceId, model: "gpt-6-sol" },
          attachments: ["chat-12345678-1234-1234-1234-123456789abc", "../invalid"].map((id) => ({
            type: "image" as const,
            id,
            name: "missing.png",
            mimeType: "image/png",
            sizeBytes: 4,
          })),
        };

        generate.mockResolvedValueOnce({ text: '{"title":"Fix This"}' });
        expect(yield* writer.generateThreadTitle(request)).toEqual({ title: "Fix This" });
        generate.mockResolvedValueOnce({ text: '{"branch":"fix-this"}' });
        expect(yield* writer.generateBranchName(request)).toEqual({ branch: "fix-this" });
        expect(generate.mock.calls.every((call) => Predicate.isString(call[0]))).toBe(true);
      }),
    ).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "akeru-writing-missing-images-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

  for (const [driver, provider, model, transport] of [
    ["codex", "openai-codex", "gpt-6-sol", "gpt-6-sol"],
    ["claudeAgent", "anthropic", "claude-sonnet-5", "claude-sonnet-5"],
    ["grok", "xai", "grok-build", "grok-4.7"],
  ] as const) {
    it.effect(
      `generates ${driver} titles and branches with a saved credential, without a CLI`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const config = yield* ServerConfig;
            const fs = yield* FileSystem.FileSystem;
            yield* fs.makeDirectory(config.secretsDir, { recursive: true });
            const instanceId = ProviderInstanceId.make(driver);

            const textGeneration = yield* makeHarnessTextGeneration({
              secretsDir: config.secretsDir,
              driver: ProviderDriverKind.make(driver),
              instanceId,
              connection: {
                environment: { PATH: "" },
                instanceEnvironment: {},
                useSavedCredential: true,
              },
            });

            yield* fs.writeFileString(
              NodePath.join(config.secretsDir, "subscription-auth.json"),
              JSON.stringify({ [provider]: { type: "api-key", access: "saved-test-key" } }),
            );

            const request = {
              cwd: config.cwd,
              message: "Fix provider onboarding",
              modelSelection: { instanceId, model },
            };

            generate.mockResolvedValueOnce({ text: '{"title":"Fix Provider Onboarding"}' });
            expect(yield* textGeneration.generateThreadTitle(request)).toEqual({
              title: "Fix Provider Onboarding",
            });
            generate.mockResolvedValueOnce({ text: '{"branch":"Fix Provider Onboarding"}' });
            expect(yield* textGeneration.generateBranchName(request)).toEqual({
              branch: "fix-provider-onboarding",
            });
            expect(agents).toHaveBeenCalledTimes(2);
            expect(agents.mock.calls[0]?.[0].model.modelId).toBe(transport);
            expect(generate.mock.calls[0]?.[0]).toContain("Fix provider onboarding");
            expect(generate.mock.calls[0]?.[1].abortSignal).toBeInstanceOf(AbortSignal);
          }),
        ).pipe(
          Effect.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "akeru-harness-writing-" }).pipe(
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
    );
  }

  it.effect("honors Codex reasoning and service-tier selections for both writing operations", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const resolver = vi.spyOn(Harness, "resolveAkeruMastraModel");
        const instanceId = ProviderInstanceId.make("codex");

        const writer = yield* makeHarnessTextGeneration({
          secretsDir: config.secretsDir,
          driver: ProviderDriverKind.make("codex"),
          instanceId,
          connection: {
            environment: { OPENAI_API_KEY: "test-key" },
            instanceEnvironment: {},
            useSavedCredential: true,
          },
        });

        const request = {
          cwd: config.cwd,
          message: "Fix provider onboarding",
          modelSelection: {
            instanceId,
            model: "gpt-6-sol",
            options: [
              { id: "reasoningEffort", value: "high" },
              { id: "serviceTier", value: "priority" },
            ],
          },
        };

        generate.mockResolvedValueOnce({ text: '{"title":"Provider Onboarding"}' });
        yield* writer.generateThreadTitle(request);
        generate.mockResolvedValueOnce({ text: '{"branch":"provider-onboarding"}' });
        yield* writer.generateBranchName(request);
        expect(resolver.mock.calls.map((call) => call[4])).toEqual([
          { reasoningEffort: "high", serviceTier: "priority" },
          { reasoningEffort: "high", serviceTier: "priority" },
        ]);
        expect(generate.mock.calls.map((call) => call[1].providerOptions)).toEqual([
          { openai: { reasoningEffort: "high", serviceTier: "priority" } },
          { openai: { reasoningEffort: "high", serviceTier: "priority" } },
        ]);
        generate.mockResolvedValueOnce({ text: '{"title":"Provider Onboarding"}' });
        yield* writer.generateThreadTitle({
          ...request,
          modelSelection: {
            ...request.modelSelection,
            options: [
              { id: "reasoningEffort", value: "off" },
              { id: "fastMode", value: true },
            ],
          },
        });
        expect(resolver.mock.calls[2]?.[4]).toEqual({
          reasoningEffort: "off",
          serviceTier: "priority",
        });
        expect(generate.mock.calls[2]?.[1].providerOptions).toEqual({
          openai: { reasoningEffort: "none", serviceTier: "priority" },
        });
      }),
    ).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "akeru-writing-options-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("passes stored screenshot bytes to title and branch generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const instanceId = ProviderInstanceId.make("codex");

        const image = {
          type: "image" as const,
          id: "chat-12345678-1234-1234-1234-123456789abc",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 4,
        };

        const imagePath = resolveAttachmentPath({
          attachmentsDir: config.attachmentsDir,
          attachment: image,
        });

        expect(imagePath).not.toBeNull();
        yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
        const bytes = new Uint8Array([137, 80, 78, 71]);
        yield* fs.writeFile(imagePath!, bytes);

        const writer = yield* makeHarnessTextGeneration({
          secretsDir: config.secretsDir,
          driver: ProviderDriverKind.make("codex"),
          instanceId,
          connection: {
            environment: { OPENAI_API_KEY: "test-key" },
            instanceEnvironment: {},
            useSavedCredential: true,
          },
        });

        const request = {
          cwd: config.cwd,
          message: "fix this",
          attachments: [
            image,
            { ...image, id: "chat-12345678-1234-1234-1234-123456789abd" },
            { ...image, id: "../invalid" },
          ],
          modelSelection: { instanceId, model: "gpt-6-sol" },
        };

        generate.mockResolvedValueOnce({ text: '{"title":"Repair Screenshot Layout"}' });
        yield* writer.generateThreadTitle(request);
        generate.mockResolvedValueOnce({ text: '{"branch":"repair-screenshot-layout"}' });
        yield* writer.generateBranchName(request);

        for (const call of generate.mock.calls) {
          expect(call[0]).toEqual([
            {
              role: "user",
              content: [
                expect.objectContaining({ type: "text" }),
                { type: "image", image: expect.any(Uint8Array), mediaType: "image/png" },
              ],
            },
          ]);
          expect(Array.from(call[0][0].content[1].image)).toEqual(Array.from(bytes));
        }
      }),
    ).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "akeru-writing-images-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("returns a typed error for invalid output", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const instanceId = ProviderInstanceId.make("codex_custom");

        const textGeneration = yield* makeHarnessTextGeneration({
          secretsDir: config.secretsDir,
          driver: ProviderDriverKind.make("codex"),
          instanceId,
          connection: {
            environment: {},
            instanceEnvironment: { OPENAI_API_KEY: "explicit-test-key" },
            useSavedCredential: false,
          },
        });

        generate.mockResolvedValueOnce({ text: "not JSON" });

        const error = yield* textGeneration
          .generateThreadTitle({
            cwd: config.cwd,
            message: "Fix readiness",
            modelSelection: { instanceId, model: "gpt-6-sol" },
          })
          .pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "TextGenerationError",
          operation: "generateThreadTitle",
        });
      }),
    ).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "akeru-harness-writing-error-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
});
