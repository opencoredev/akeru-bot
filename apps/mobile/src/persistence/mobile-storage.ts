import { EnvironmentId } from "@akeru/contracts";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { type SavedRemoteConnection } from "../lib/connection";
import * as MobileSecureStorage from "./mobile-secure-storage";

const CONNECTIONS_KEY = "akeru.connections";
const AGENT_AWARENESS_DEVICE_ID_KEY = "akeru.agent-awareness.device-id";
const AGENT_AWARENESS_REGISTRATION_KEY = "akeru.agent-awareness.registration";
const RECENT_THREAD_SHORTCUTS_KEY = "akeru.recent-thread-shortcuts";

// Keys written before the rebrand; each read falls back to the legacy key
// once and the next write lands on the Akeru key, draining the old entry.
const LEGACY_KEYS: ReadonlyArray<readonly [string, string]> = [
  [CONNECTIONS_KEY, "t3code.connections"],
  [AGENT_AWARENESS_DEVICE_ID_KEY, "t3code.agent-awareness.device-id"],
  [AGENT_AWARENESS_REGISTRATION_KEY, "t3code.agent-awareness.registration"],
  [RECENT_THREAD_SHORTCUTS_KEY, "t3code.recent-thread-shortcuts"],
];

export class MobileStorageDecodeError extends Schema.TaggedErrorClass<MobileStorageDecodeError>()(
  "MobileStorageDecodeError",
  {
    key: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode mobile storage value for key ${this.key}.`;
  }
}

export class MobileStorageEncodeError extends Schema.TaggedErrorClass<MobileStorageEncodeError>()(
  "MobileStorageEncodeError",
  {
    key: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to encode mobile storage value for key ${this.key}.`;
  }
}

export class MobileDeviceIdGenerationError extends Schema.TaggedErrorClass<MobileDeviceIdGenerationError>()(
  "MobileDeviceIdGenerationError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to generate the mobile agent-awareness device id.";
  }
}

export interface AgentAwarenessRegistrationRecord {
  readonly identity: string;
  readonly signature: string;
  readonly pushToStartToken?: string;
}

export interface RecentThreadShortcut {
  readonly environmentId: string;
  readonly threadId: string;
  readonly title: string;
}

export class MobileStorage extends Context.Service<
  MobileStorage,
  {
    readonly loadSavedConnections: Effect.Effect<
      ReadonlyArray<SavedRemoteConnection>,
      MobileSecureStorage.MobileSecureStorageError
    >;
    readonly saveConnection: (
      connection: SavedRemoteConnection,
    ) => Effect.Effect<
      void,
      MobileSecureStorage.MobileSecureStorageError | MobileStorageEncodeError
    >;
    readonly clearSavedConnection: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<
      void,
      MobileSecureStorage.MobileSecureStorageError | MobileStorageEncodeError
    >;
    readonly loadOrCreateAgentAwarenessDeviceId: Effect.Effect<
      string,
      MobileSecureStorage.MobileSecureStorageError | MobileDeviceIdGenerationError
    >;
    readonly loadAgentAwarenessDeviceId: Effect.Effect<
      string | null,
      MobileSecureStorage.MobileSecureStorageError
    >;
    readonly loadAgentAwarenessRegistrationRecord: Effect.Effect<
      AgentAwarenessRegistrationRecord | null,
      MobileSecureStorage.MobileSecureStorageError
    >;
    readonly saveAgentAwarenessRegistrationRecord: (
      record: AgentAwarenessRegistrationRecord,
    ) => Effect.Effect<
      void,
      MobileSecureStorage.MobileSecureStorageError | MobileStorageEncodeError
    >;
    readonly clearAgentAwarenessRegistrationRecord: Effect.Effect<
      void,
      MobileSecureStorage.MobileSecureStorageError
    >;
    readonly loadRecentThreadShortcuts: Effect.Effect<
      ReadonlyArray<RecentThreadShortcut>,
      MobileSecureStorage.MobileSecureStorageError
    >;
    readonly saveRecentThreadShortcuts: (
      threads: ReadonlyArray<RecentThreadShortcut>,
    ) => Effect.Effect<
      void,
      MobileSecureStorage.MobileSecureStorageError | MobileStorageEncodeError
    >;
  }
>()("@akeru/mobile/persistence/MobileStorage") {}

export const make = Effect.fn("MobileStorage.make")(function* () {
  const secureStorage = yield* MobileSecureStorage.MobileSecureStorage;

  const parseJson = <A>(key: string, raw: string): A | null => {
    if (!raw.trim()) return null;
    try {
      return JSON.parse(raw) as A;
    } catch (cause) {
      console.warn(
        "[mobile-storage] ignored invalid JSON",
        new MobileStorageDecodeError({ key, cause }),
      );
      return null;
    }
  };

  const getItem = Effect.fn("MobileStorage.getItem")(function* (key: string) {
    const value = yield* secureStorage.getItem(key);
    if (value !== null) return value;
    const legacyKey = LEGACY_KEYS.find(([current]) => current === key)?.[1];
    if (legacyKey === undefined) return null;
    const legacy = yield* secureStorage.getItem(legacyKey);
    if (legacy !== null) {
      // Copy the pre-rebrand value forward so the next write can drain it.
      yield* secureStorage
        .setItem(key, legacy)
        .pipe(Effect.andThen(secureStorage.removeItem(legacyKey)), Effect.ignore);
    }
    return legacy;
  });

  const readJson = Effect.fn("MobileStorage.readJson")(function* <A>(key: string) {
    const raw = (yield* getItem(key)) ?? "";
    return parseJson<A>(key, raw);
  });

  const setItem = Effect.fn("MobileStorage.setItem")(function* (key: string, value: string) {
    yield* secureStorage.setItem(key, value);
    const legacyKey = LEGACY_KEYS.find(([current]) => current === key)?.[1];
    if (legacyKey !== undefined) {
      yield* secureStorage.removeItem(legacyKey).pipe(Effect.ignore);
    }
  });

  const writeJson = Effect.fn("MobileStorage.writeJson")(function* (key: string, value: unknown) {
    const encoded = yield* Effect.try({
      try: () => JSON.stringify(value),
      catch: (cause) => new MobileStorageEncodeError({ key, cause }),
    });
    yield* setItem(key, encoded);
  });

  const loadSavedConnections = readJson<{
    readonly connections?: ReadonlyArray<SavedRemoteConnection>;
  }>(CONNECTIONS_KEY).pipe(
    Effect.map((parsed) =>
      pipe(
        parsed?.connections ?? [],
        Arr.filter((connection) => !!connection.environmentId && !!connection.bearerToken?.trim()),
      ),
    ),
  );

  const saveConnection = Effect.fn("MobileStorage.saveConnection")(function* (
    connection: SavedRemoteConnection,
  ) {
    const current = yield* loadSavedConnections;
    const next = current.some((entry) => entry.environmentId === connection.environmentId)
      ? pipe(
          current,
          Arr.map((entry) =>
            entry.environmentId === connection.environmentId ? connection : entry,
          ),
        )
      : pipe(current, Arr.append(connection));
    yield* writeJson(CONNECTIONS_KEY, { connections: next });
  });

  const clearSavedConnection = Effect.fn("MobileStorage.clearSavedConnection")(function* (
    environmentId: EnvironmentId,
  ) {
    const current = yield* loadSavedConnections;
    const next = pipe(
      current,
      Arr.filter((entry) => entry.environmentId !== environmentId),
    );
    yield* writeJson(CONNECTIONS_KEY, { connections: next });
  });

  const loadOrCreateAgentAwarenessDeviceId = Effect.gen(function* () {
    const existing = yield* getItem(AGENT_AWARENESS_DEVICE_ID_KEY);
    if (existing?.trim()) return existing;
    const deviceId = yield* Effect.tryPromise({
      try: () => import("../lib/uuid").then(({ uuidv4 }) => uuidv4()),
      catch: (cause) => new MobileDeviceIdGenerationError({ cause }),
    });
    yield* setItem(AGENT_AWARENESS_DEVICE_ID_KEY, deviceId);
    return deviceId;
  });

  const loadAgentAwarenessDeviceId = getItem(AGENT_AWARENESS_DEVICE_ID_KEY).pipe(
    Effect.map((existing) => (existing?.trim() ? existing : null)),
  );

  const loadAgentAwarenessRegistrationRecord = readJson<AgentAwarenessRegistrationRecord>(
    AGENT_AWARENESS_REGISTRATION_KEY,
  ).pipe(
    Effect.map((parsed) => {
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof parsed.identity !== "string" ||
        typeof parsed.signature !== "string"
      ) {
        return null;
      }
      return {
        identity: parsed.identity,
        signature: parsed.signature,
        ...(typeof parsed.pushToStartToken === "string" && parsed.pushToStartToken
          ? { pushToStartToken: parsed.pushToStartToken }
          : {}),
      };
    }),
  );

  // Threads most recently opened on this device, newest first — the source
  // for the launcher's dynamic "recent thread" app shortcuts.
  const loadRecentThreadShortcuts = readJson<{
    readonly threads?: ReadonlyArray<RecentThreadShortcut>;
  }>(RECENT_THREAD_SHORTCUTS_KEY).pipe(
    Effect.map((parsed) =>
      pipe(
        parsed?.threads ?? [],
        Arr.filter(
          (thread) =>
            typeof thread?.environmentId === "string" &&
            thread.environmentId.length > 0 &&
            typeof thread.threadId === "string" &&
            thread.threadId.length > 0 &&
            typeof thread.title === "string",
        ),
      ),
    ),
  );

  return MobileStorage.of({
    loadSavedConnections,
    saveConnection,
    clearSavedConnection,
    loadOrCreateAgentAwarenessDeviceId,
    loadAgentAwarenessDeviceId,
    loadAgentAwarenessRegistrationRecord,
    saveAgentAwarenessRegistrationRecord: (record) =>
      writeJson(AGENT_AWARENESS_REGISTRATION_KEY, record),
    clearAgentAwarenessRegistrationRecord: setItem(AGENT_AWARENESS_REGISTRATION_KEY, ""),
    loadRecentThreadShortcuts,
    saveRecentThreadShortcuts: (threads) => writeJson(RECENT_THREAD_SHORTCUTS_KEY, { threads }),
  });
});

export const layer = Layer.effect(MobileStorage, make());
