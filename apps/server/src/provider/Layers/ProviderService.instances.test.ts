import { ProviderDriverKind, ProviderInstanceId } from "@akeru/contracts";
import { createModelSelection } from "@akeru/shared/model";
import { it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { ProviderUnsupportedError, ProviderValidationError } from "../Errors.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import { providerServiceLayerWith } from "./ProviderService.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { adapterRegistryMock } from "../testUtils/providerAdapterRegistryMock.ts";
import {
  defaultServerSettingsLayer,
  serverConfigTestLayer,
  asThreadId,
  codexInstanceId,
  claudeAgentInstanceId,
  CODEX_DRIVER,
  CLAUDE_AGENT_DRIVER,
  makeFakeCodexAdapter,
  makeProviderServiceHarness,
} from "./test-support/providerServiceHarness.ts";

const { routing, validation } = makeProviderServiceHarness();

it.effect("ProviderServiceLive rejects new sessions for disabled providers", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const claude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);

    const registryBase = adapterRegistryMock({
      [CODEX_DRIVER]: codex.adapter,
      [CLAUDE_AGENT_DRIVER]: claude.adapter,
    });

    const registry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"] = {
      ...registryBase,
      getInstanceInfo: (instanceId) =>
        instanceId === claudeAgentInstanceId
          ? Effect.succeed({
              instanceId,
              driverKind: CLAUDE_AGENT_DRIVER,
              displayName: undefined,
              enabled: false,
              continuationIdentity: {
                driverKind: CLAUDE_AGENT_DRIVER,
                continuationKey: "claudeAgent:instance:claudeAgent",
              },
            })
          : registryBase.getInstanceInfo(instanceId),
    };

    const providerAdapterLayer = Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistry,
      registry,
    );

    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );

    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

    const providerLayer = providerServiceLayerWith().pipe(
      Layer.provide(providerAdapterLayer),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(serverConfigTestLayer),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    const failure = yield* Effect.flip(
      Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;

        return yield* provider.startSession(asThreadId("thread-disabled"), {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-disabled"),
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer)),
    );

    assert.instanceOf(failure, ProviderValidationError);
    assert.include(failure.issue, "Provider instance 'claudeAgent' is disabled");
    assert.equal(claude.startSession.mock.calls.length, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ProviderServiceLive allows enabled custom instances when legacy driver is disabled",
  () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex_personal");
      const driverKind = CODEX_DRIVER;
      const codex = makeFakeCodexAdapter();

      const unsupported = () =>
        new ProviderUnsupportedError({
          provider: driverKind,
        });

      const instanceInfo = {
        instanceId,
        driverKind,
        displayName: "Codex Personal",
        enabled: true,
        continuationIdentity: {
          driverKind,
          continuationKey: "codex:/Users/example/.codex",
        },
      } as const;

      const registry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"] = {
        getByInstance: (requestedInstanceId) =>
          requestedInstanceId === instanceId
            ? Effect.succeed(codex.adapter)
            : Effect.fail(unsupported()),
        getInstanceInfo: (requestedInstanceId) =>
          requestedInstanceId === instanceId
            ? Effect.succeed(instanceInfo)
            : Effect.fail(unsupported()),
        dispatchIfEnabled: (requestedInstanceId, dispatch) =>
          Effect.sync(() =>
            requestedInstanceId === instanceId
              ? ({ _tag: "Dispatched", value: dispatch() } as const)
              : ({ _tag: "Missing" } as const),
          ),
        listInstances: () => Effect.succeed([instanceId]),
        listProviders: () => Effect.succeed([driverKind] as const),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
          PubSub.subscribe(pubsub),
        ),
      };

      const providerAdapterLayer = Layer.succeed(
        ProviderAdapterRegistry.ProviderAdapterRegistry,
        registry,
      );

      const serverSettingsLayer = ServerSettings.ServerSettingsService.layerTest({
        providers: {
          codex: {
            enabled: false,
          },
        },
      });

      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(SqlitePersistenceMemory),
      );

      const directoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );

      const providerLayer = providerServiceLayerWith().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(serverSettingsLayer),
        Layer.provide(serverConfigTestLayer),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      const session = yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;

        return yield* provider.startSession(asThreadId("thread-enabled-custom"), {
          provider: driverKind,
          providerInstanceId: instanceId,
          threadId: asThreadId("thread-enabled-custom"),
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer));

      assert.equal(session.providerInstanceId, instanceId);
      assert.equal(codex.startSession.mock.calls.length, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ProviderServiceLive rejects new sessions for disabled custom instances", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("codex_personal");
    const driverKind = ProviderDriverKind.make("codex");
    const codex = makeFakeCodexAdapter();

    const unsupported = () =>
      new ProviderUnsupportedError({
        provider: ProviderDriverKind.make("codex"),
      });

    const instanceInfo = {
      instanceId,
      driverKind,
      displayName: "Codex Personal",
      enabled: false,
      continuationIdentity: {
        driverKind,
        continuationKey: "codex:/Users/example/.codex",
      },
    } as const;

    const registry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"] = {
      getByInstance: (requestedInstanceId) =>
        requestedInstanceId === instanceId
          ? Effect.succeed(codex.adapter)
          : Effect.fail(unsupported()),
      getInstanceInfo: (requestedInstanceId) =>
        requestedInstanceId === instanceId
          ? Effect.succeed(instanceInfo)
          : Effect.fail(unsupported()),
      dispatchIfEnabled: (requestedInstanceId, _dispatch) =>
        Effect.sync(() =>
          requestedInstanceId === instanceId
            ? ({ _tag: "Disabled" } as const)
            : ({ _tag: "Missing" } as const),
        ),
      listInstances: () => Effect.succeed([instanceId]),
      listProviders: () => Effect.succeed([CODEX_DRIVER] as const),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
        PubSub.subscribe(pubsub),
      ),
    };

    const providerAdapterLayer = Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistry,
      registry,
    );

    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );

    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

    const providerLayer = providerServiceLayerWith().pipe(
      Layer.provide(providerAdapterLayer),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(serverConfigTestLayer),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    const failure = yield* Effect.flip(
      Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;

        return yield* provider.startSession(asThreadId("thread-disabled-instance"), {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: instanceId,
          threadId: asThreadId("thread-disabled-instance"),
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer)),
    );

    assert.instanceOf(failure, ProviderValidationError);
    assert.include(failure.issue, "Provider instance 'codex_personal' is disabled");
    assert.equal(codex.startSession.mock.calls.length, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

routing.layer("ProviderServiceLive routing", (it) => {
  it.effect("rejects a sendTurn whose modelSelection targets a different instance", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      routing.codex.sendTurn.mockClear();

      const failure = yield* Effect.flip(
        provider.sendTurn({
          threadId: session.threadId,
          input: "wrong instance",
          attachments: [],
          modelSelection: createModelSelection(claudeAgentInstanceId, "claude-opus-4-6"),
        }),
      );

      assert.instanceOf(failure, ProviderValidationError);
      assert.include(
        failure.issue,
        "Model selection targets provider instance 'claudeAgent' but thread 'thread-1' is bound to 'codex'.",
      );
      assert.equal(routing.codex.sendTurn.mock.calls.length, 0);
    }),
  );
});

routing.layer("ProviderServiceLive routing", (it) => {
  it.effect("stops stale sessions in other providers after a successful replacement start", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-provider-replacement");

      const codexSession = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-provider-replacement",
        runtimeMode: "full-access",
      });

      routing.codex.stopSession.mockClear();
      routing.claude.stopSession.mockClear();

      const claudeSession = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId,
        cwd: "/tmp/project-provider-replacement",
        runtimeMode: "full-access",
      });

      assert.equal(codexSession.provider, "codex");
      assert.equal(claudeSession.provider, "claudeAgent");
      assert.deepEqual(routing.codex.stopSession.mock.calls, [[threadId]]);
      assert.equal(routing.claude.stopSession.mock.calls.length, 0);

      const sessions = yield* provider.listSessions();
      assert.deepEqual(
        sessions
          .filter((session) => session.threadId === threadId)
          .map((session) => session.provider),
        ["claudeAgent"],
      );
    }),
  );
});

validation.layer("ProviderServiceLive validation", (it) => {
  it.effect("rejects session starts without an explicit provider instance id", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      validation.codex.startSession.mockClear();

      const failure = yield* Effect.flip(
        provider.startSession(asThreadId("thread-missing-instance-id"), {
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-missing-instance-id"),
          runtimeMode: "full-access",
        }),
      );

      assert.instanceOf(failure, ProviderValidationError);
      assert.include(failure.issue, "Provider instance id is required for provider 'codex'.");
      assert.equal(validation.codex.startSession.mock.calls.length, 0);
    }),
  );
});

validation.layer("ProviderServiceLive validation", (it) => {
  it.effect("rejects mismatched provider kind and provider instance id", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      validation.codex.startSession.mockClear();
      validation.claude.startSession.mockClear();

      const failure = yield* Effect.flip(
        provider.startSession(asThreadId("thread-instance-mismatch"), {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-instance-mismatch"),
          runtimeMode: "full-access",
        }),
      );

      assert.instanceOf(failure, ProviderValidationError);
      assert.include(
        failure.issue,
        "Provider instance 'claudeAgent' belongs to driver 'claudeAgent', not 'codex'.",
      );
      assert.equal(validation.codex.startSession.mock.calls.length, 0);
      assert.equal(validation.claude.startSession.mock.calls.length, 0);
    }),
  );
});
