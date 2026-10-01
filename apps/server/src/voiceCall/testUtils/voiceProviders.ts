import { BotId, type VoiceSettings } from "@akeru/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ServerConfig } from "../../config.ts";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  ProjectionBotRepository,
  type ProjectionBotRepositoryShape,
} from "../../persistence/Services/ProjectionBots.ts";
import { layer } from "../VoiceCallManager.ts";
import { type VoiceAdapters } from "../VoiceAdapters.ts";

const botId = BotId.make("voice-provider-bot");

const repository = {
  upsert: () => Effect.void,
  listAll: () => Effect.succeed([]),
  getById: () =>
    Effect.succeed(
      Option.some({
        botId,
        name: "Akeru",
        title: "Generalist",
        label: null,
        description: null,
        disabledMcpServerIds: [],
        avatar: { kind: "blob" as const, shape: "circle" as const, color: "#123456" },
        engine: null,
        sandbox: null,
        runtimeMode: "full-access" as const,
        usageCap: null,
        imageProvider: null,
        voiceEnabled: true,
        groupId: null,
        archivedAt: null,
        createdAt: "2026-08-27T00:00:00.000Z",
        updatedAt: "2026-08-27T00:00:00.000Z",
      }),
    ),
  deleteById: () => Effect.void,
} satisfies ProjectionBotRepositoryShape;

const defaults: VoiceAdapters = {
  test: async () => undefined,
  listVoices: async () => ({ voices: [{ id: "alloy", name: "Alloy" }] }),
  validateVoice: async () => undefined,
  transcribe: async () => ({ text: "transcript" }),
  synthesize: async () => ({ audioBase64: "bXAz", mimeType: "audio/mpeg" }),
  negotiate: async () => "answer-sdp",
};

const makeTest = (
  adapters: Partial<VoiceAdapters> = {},
  voice: Partial<VoiceSettings> = {},
  values = new Map<string, Uint8Array>(),
) => {
  const secrets = ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(values.get(name))),
    set: (name, value) =>
      Effect.sync(() => {
        values.set(name, value);
      }),
    remove: (name) =>
      Effect.sync(() => {
        values.delete(name);
      }),
    create: (name, value) =>
      Effect.sync(() => {
        values.set(name, value);
      }),
    getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
  });
  return layer({ adapters: { ...defaults, ...adapters } }).pipe(
    Layer.provide(Layer.succeed(ProjectionBotRepository, repository)),
    Layer.provide(Layer.succeed(ServerSecretStore, secrets)),
    Layer.provideMerge(
      ServerSettingsService.layerTest({ voice: { provider: "composed", ...voice } }),
    ),
    Layer.provide(NodeServices.layer),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "voice-providers-test-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
};
export { botId, repository, defaults, makeTest };
