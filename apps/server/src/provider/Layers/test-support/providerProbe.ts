import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import {
  ClaudeSettings,
  CodexSettings,
  DEFAULT_SERVER_SETTINGS,
  ServerSettings,
  type ServerProvider,
  type ServerProviderSlashCommand,
  type ServerSettings as ContractServerSettings,
} from "@akeru/contracts";
import * as PlatformError from "effect/PlatformError";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@akeru/shared/model";
import { applyServerSettingsPatch } from "@akeru/shared/serverSettings";
import { type CodexAppServerProviderSnapshot } from "../CodexProvider.ts";
import * as BackgroundPolicy from "../../../background/BackgroundPolicy.ts";
import * as ServerSettingsModule from "../../../serverSettings.ts";

export const decodeServerSettings = Schema.decodeSync(ServerSettings);

export const encodeServerSettings = Schema.encodeSync(ServerSettings);

export const encodedDefaultServerSettings = encodeServerSettings(DEFAULT_SERVER_SETTINGS);

export const defaultClaudeSettings: ClaudeSettings = Schema.decodeSync(ClaudeSettings)({});

export const defaultCodexSettings: CodexSettings = Schema.decodeSync(CodexSettings)({});

export const decodeCodexSettings = Schema.decodeSync(CodexSettings);

export const disabledCodexSettings: CodexSettings = Schema.decodeSync(CodexSettings)({
  enabled: false,
});

export const encoder = new TextEncoder();

export const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

export const TestHttpClientLive = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
);

export const BackgroundPolicyAlwaysRunLayer = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
  reportClientActivity: () => Effect.void,
  removeRpcClient: () => Effect.void,
  reportHostPowerState: () => Effect.void,
  snapshot: Effect.succeed({
    hostPower: {
      source: "unknown",
      idle: "unknown",
      idleSeconds: null,
      locked: "unknown",
      suspended: false,
      onBattery: "unknown",
      lowPowerMode: "unknown",
      thermalState: "unknown",
      stale: true,
      updatedAt: TEST_EPOCH,
    },
    leases: [],
    activeForegroundLeaseCount: 0,
    activeScopeKeys: [],
    shouldRunOpportunisticWork: true,
    updatedAt: TEST_EPOCH,
  }),
  streamChanges: Stream.empty,
  hasDemand: () => Effect.succeed(true),
  shouldRunScopeWork: () => Effect.succeed(true),
  shouldRunOpportunisticWork: Effect.succeed(true),
});

export function selectDescriptor(
  id: string,
  label: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
) {
  return {
    id,
    label,
    type: "select" as const,
    options: [...options],
    ...(options.find((option) => option.isDefault)?.id
      ? { currentValue: options.find((option) => option.isDefault)?.id }
      : {}),
  };
}

export function booleanDescriptor(id: string, label: string) {
  return {
    id,
    label,
    type: "boolean" as const,
  };
}

export type TestClaudeCapabilities = {
  readonly email: string | undefined;
  readonly subscriptionType: string | undefined;
  readonly tokenSource: string | undefined;
  readonly apiProvider: string | undefined;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
};

export function claudeCapabilities(overrides: Partial<TestClaudeCapabilities> = {}) {
  return () =>
    Effect.succeed({
      email: undefined,
      subscriptionType: undefined,
      tokenSource: undefined,
      apiProvider: undefined,
      slashCommands: [],
      ...overrides,
    });
}

export const noClaudeCapabilities = () =>
  Effect.sync(() => undefined as TestClaudeCapabilities | undefined);

export function mockHandle(result: { stdout: string; stderr: string; code: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout)),
    stderr: Stream.make(encoder.encode(result.stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

export function mockSpawnerLayer(
  handler: (args: ReadonlyArray<string>) => {
    stdout: string;
    stderr: string;
    code: number;
  },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as { args: ReadonlyArray<string> };

      return Effect.succeed(mockHandle(handler(cmd.args)));
    }),
  );
}

export function recordingMockSpawnerLayer(
  handler: (args: ReadonlyArray<string>) => {
    stdout: string;
    stderr: string;
    code: number;
  },
) {
  const commands: Array<{
    readonly args: ReadonlyArray<string>;
    readonly env: NodeJS.ProcessEnv | undefined;
  }> = [];

  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as {
        args: ReadonlyArray<string>;
        options?: {
          readonly env?: NodeJS.ProcessEnv;
        };
      };

      commands.push({ args: cmd.args, env: cmd.options?.env });

      return Effect.succeed(mockHandle(handler(cmd.args)));
    }),
  );

  return { layer, commands };
}

export function mockCommandSpawnerLayer(
  handler: (
    command: string,
    args: ReadonlyArray<string>,
  ) => { stdout: string; stderr: string; code: number },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as {
        command: string;
        args: ReadonlyArray<string>;
      };

      return Effect.succeed(mockHandle(handler(cmd.command, cmd.args)));
    }),
  );
}

export function failingSpawnerLayer(description: string) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description,
        }),
      ),
    ),
  );
}

export function hangingScopedSpawnerLayer(killCalls: Ref.Ref<number>) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.gen(function* () {
        const handle = ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Ref.update(killCalls, (current) => current + 1),
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.never,
          stderr: Stream.never,
          all: Stream.never,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });

        yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));

        return handle;
      }),
    ),
  );
}

export const codexModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    selectDescriptor("reasoningEffort", "Reasoning", [
      { id: "high", label: "High", isDefault: true },
      { id: "low", label: "Low" },
    ]),
    booleanDescriptor("fastMode", "Fast Mode"),
  ],
}) satisfies NonNullable<ServerProvider["models"][number]["capabilities"]>;

export function makeCodexProbeSnapshot(
  input: Partial<CodexAppServerProviderSnapshot> = {},
): CodexAppServerProviderSnapshot {
  return {
    version: "1.0.0",
    account: {
      account: {
        type: "chatgpt",
        email: "test@example.com",
        planType: "pro",
      },
      requiresOpenaiAuth: false,
    },
    models: [
      {
        slug: "gpt-live-codex",
        name: "GPT Live Codex",
        isCustom: false,
        capabilities: codexModelCapabilities,
      },
    ],
    skills: [],
    ...input,
  };
}

export function makeMutableServerSettingsService(
  initial: ContractServerSettings = DEFAULT_SERVER_SETTINGS,
) {
  return Effect.gen(function* () {
    const settingsRef = yield* Ref.make(initial);
    const changes = yield* PubSub.unbounded<ContractServerSettings>();

    return {
      start: Effect.void,
      ready: Effect.void,
      getSettings: Ref.get(settingsRef),
      updateSettings: (patch) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(settingsRef);
          const next = applyServerSettingsPatch(current, patch);
          encodeServerSettings(next);
          yield* Ref.set(settingsRef, next);
          yield* PubSub.publish(changes, next);

          return next;
        }),
      get streamChanges() {
        return Stream.fromPubSub(changes);
      },
      get subscribeChanges() {
        return PubSub.subscribe(changes).pipe(
          Effect.map((subscription) => Stream.fromSubscription(subscription)),
        );
      },
    } satisfies ServerSettingsModule.ServerSettingsService["Service"];
  });
}
