// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import { AuthStorage } from "@mastra/code-sdk/auth/storage";
import { Agent } from "@mastra/core/agent";
import {
  TextGenerationError,
  DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
  type ModelSelection,
  type ChatAttachment,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@akeru/contracts";
import { sanitizeBranchFragment } from "@akeru/shared/git";
import { getModelSelectionStringOptionValue } from "@akeru/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { mastraModelId, resolveAkeruMastraModel } from "../provider/AkeruMastraHarness.ts";
import { ServerConfig } from "../config.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import { getCodexServiceTierOptionValue } from "../codexModelOptions.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { SubscriptionAuthService } from "../subscription-auth/service.ts";
import type { TextGeneration } from "./TextGeneration.ts";
import { buildBranchNamePrompt, buildThreadTitlePrompt } from "./TextGenerationPrompts.ts";
import { sanitizeThreadTitle } from "./TextGenerationUtils.ts";

const decodeServiceTier = Schema.decodeUnknownEffect(
  Schema.Literals(["auto", "default", "flex", "priority"]),
);
const decodeReasoningEffort = Schema.decodeUnknownEffect(
  Schema.Literals(["none", "minimal", "low", "medium", "high", "xhigh", "max"]),
);

export const makeHarnessTextGeneration = Effect.fn("makeHarnessTextGeneration")(function* (input: {
  readonly secretsDir: string;
  readonly driver: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly connection: NonNullable<ProviderInstance["mastraConnection"]>;
}) {
  const auth = yield* SubscriptionAuthService.forSecretsDir(input.secretsDir);
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig;
  const authStorage = new AuthStorage(NodePath.join(input.secretsDir, "subscription-auth.json"));
  const generate = <Output>(
    operation: "generateBranchName" | "generateThreadTitle",
    modelSelection: ModelSelection,
    prompt: string,
    outputSchema: Schema.Codec<Output>,
    attachments: ReadonlyArray<ChatAttachment> = [],
  ) =>
    Effect.gen(function* () {
      yield* auth.reload();
      const images = yield* Effect.forEach(
        attachments.filter((attachment) => attachment.type === "image"),
        (attachment) =>
          Effect.gen(function* () {
            const path = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (path === null)
              return yield* new TextGenerationError({
                operation,
                detail: `Attachment '${attachment.id}' has an invalid path.`,
              });
            const bytes = yield* fileSystem.readFile(path).pipe(
              Effect.mapError(
                (cause) =>
                  new TextGenerationError({
                    operation,
                    detail: `Could not read attachment '${attachment.id}'.`,
                    cause,
                  }),
              ),
            );
            return { type: "image" as const, image: bytes, mediaType: attachment.mimeType };
          }),
      );
      const selectedTier =
        input.driver === "codex" ? getCodexServiceTierOptionValue(modelSelection) : undefined;
      const serviceTier =
        selectedTier === undefined
          ? undefined
          : yield* decodeServiceTier(selectedTier === "fast" ? "priority" : selectedTier).pipe(
              Effect.mapError(
                (cause) =>
                  new TextGenerationError({
                    operation,
                    detail: "The selected service tier is not supported by the Akeru harness.",
                    cause,
                  }),
              ),
            );
      const selectedEffort =
        input.driver === "codex"
          ? (getModelSelectionStringOptionValue(modelSelection, "reasoningEffort") ??
            DEFAULT_TEXT_GENERATION_REASONING_EFFORT)
          : undefined;
      const reasoningEffort =
        selectedEffort === undefined
          ? undefined
          : yield* decodeReasoningEffort(selectedEffort === "off" ? "none" : selectedEffort).pipe(
              Effect.mapError(
                (cause) =>
                  new TextGenerationError({
                    operation,
                    detail: "The selected reasoning effort is not supported by the Akeru harness.",
                    cause,
                  }),
              ),
            );
      const modelOptions = reasoningEffort
        ? {
            reasoningEffort: reasoningEffort === "none" ? "off" : reasoningEffort,
            ...(serviceTier ? { serviceTier } : {}),
          }
        : undefined;
      const text = yield* Effect.tryPromise({
        try: async (abortSignal) => {
          const resolved = resolveAkeruMastraModel(
            mastraModelId(input.driver, modelSelection.model),
            authStorage,
            undefined,
            undefined,
            modelOptions,
            (provider, instanceId) => auth.getApiKeyCredential(provider, instanceId),
            { ...input.connection, instanceId: input.instanceId },
            (provider, instanceId) => auth.getOAuthCredential(provider, instanceId),
            (provider, instanceId) => auth.getAccessToken(provider, instanceId),
          );
          const agent = new Agent({
            id: `akeru-${operation}-${input.instanceId}`,
            name: "Akeru writing",
            instructions: "Return only the requested JSON object.",
            model: resolved,
          });
          const message =
            images.length === 0
              ? prompt
              : [
                  {
                    role: "user" as const,
                    content: [{ type: "text" as const, text: prompt }, ...images],
                  },
                ];
          const runOptions = reasoningEffort
            ? {
                providerOptions: {
                  openai: {
                    reasoningEffort,
                    ...(serviceTier ? { serviceTier } : {}),
                  },
                },
              }
            : {};
          const result = await agent.generate(message, { ...runOptions, abortSignal });
          return result.text;
        },
        catch: (cause) =>
          new TextGenerationError({
            operation,
            detail: "Akeru harness text generation failed.",
            cause,
          }),
      });
      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(outputSchema))(
        text.trim(),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Akeru harness returned invalid writing output.",
              cause,
            }),
        ),
      );
    });
  return {
    generateBranchName: (request) => {
      const { prompt, outputSchema } = buildBranchNamePrompt(request);
      return generate(
        "generateBranchName",
        request.modelSelection,
        prompt,
        outputSchema,
        request.attachments,
      ).pipe(Effect.map((result) => ({ branch: sanitizeBranchFragment(result.branch) })));
    },
    generateThreadTitle: (request) => {
      const { prompt, outputSchema } = buildThreadTitlePrompt(request);
      return generate(
        "generateThreadTitle",
        request.modelSelection,
        prompt,
        outputSchema,
        request.attachments,
      ).pipe(Effect.map((result) => ({ title: sanitizeThreadTitle(result.title) })));
    },
  } satisfies TextGeneration["Service"];
});
