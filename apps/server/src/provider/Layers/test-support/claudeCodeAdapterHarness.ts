import * as NodeStream from "node:stream";

import * as NodeEvents from "node:events";

import { type SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import {
  ClaudeSettings,
  DEFAULT_BOT_PERMISSION_POLICY,
  ProviderInstanceId,
  type BotPermissionPolicy,
  type ProviderInstanceEnvironment,
  type ProviderRuntimeEvent,
} from "@akeru/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../../config.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import {
  claudeCodeAdapterOptions,
  claudeCodeInstanceEnvironment,
} from "../../claudeCode/ClaudeCodeSession.ts";
import { makeClaudeAdapter, type ClaudeAdapterLiveOptions } from "../ClaudeAdapter.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

export const CLAUDE_CODE_SETTINGS = decodeClaudeSettings({});

export const CLAUDE_CODE_INSTANCE_ID = ProviderInstanceId.make("claudeCode");

/** The server's environment, holding every credential a login must never see. */
export const HOSTILE_SERVER_ENVIRONMENT: NodeJS.ProcessEnv = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/akeru-test",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-server",
  ANTHROPIC_API_KEY: "sk-ant-api-server",
  ANTHROPIC_AUTH_TOKEN: "gateway-token",
  ANTHROPIC_BASE_URL: "https://gateway.example.com",
  ANTHROPIC_CUSTOM_HEADERS: "x-claude-code: impersonate",
  ANTHROPIC_BETAS: "claude-code-20250219",
  CLAUDE_CODE_SIMPLE: "1",
  CLAUDE_CODE_USE_BEDROCK: "1",
  CLAUDE_CODE_USE_VERTEX: "1",
  CLAUDE_CODE_USE_FOUNDRY: "1",
  AWS_ACCESS_KEY_ID: "AKIA-server",
  AWS_SECRET_ACCESS_KEY: "secret",
  GOOGLE_APPLICATION_CREDENTIALS: "/home/akeru-test/gcp.json",
  CLAUDE_CONFIG_DIR: "/home/akeru-test/.inherited-claude",
  HTTPS_PROXY: "http://proxy.example.com",
  no_proxy: "localhost",
  NODE_EXTRA_CA_CERTS: "/etc/ssl/corp.pem",
};

export const HOSTILE_INSTANCE_ENVIRONMENT: ProviderInstanceEnvironment = [
  { name: "ANTHROPIC_API_KEY", value: "sk-ant-api-instance", sensitive: true },
  { name: "ANTHROPIC_BASE_URL", value: "https://instance-gateway.example.com", sensitive: false },
  { name: "CLAUDE_CODE_USE_BEDROCK", value: "1", sensitive: false },
  { name: "AKERU_CLAUDE_PATH", value: "/opt/claude/bin/claude", sensitive: false },
];

export const policyWith = (
  overrides: Partial<BotPermissionPolicy["defaults"]>,
): BotPermissionPolicy => ({
  ...DEFAULT_BOT_PERMISSION_POLICY,
  defaults: { ...DEFAULT_BOT_PERMISSION_POLICY.defaults, ...overrides },
});

export function makeClaudeCodeAdapter(
  createQuery: NonNullable<ClaudeAdapterLiveOptions["createQuery"]>,
  environment: {
    readonly base?: NodeJS.ProcessEnv;
    readonly instance?: ProviderInstanceEnvironment;
    readonly settings?: Partial<ClaudeSettings>;
    /** The folder the server assigns a separate account that names none. */
    readonly assignedConfigDirectory?: string;
  } = {},
) {
  return Effect.gen(function* () {
    const settings = decodeClaudeSettings(environment.settings ?? {});

    const login = yield* claudeCodeInstanceEnvironment(
      settings,
      environment.instance ?? HOSTILE_INSTANCE_ENVIRONMENT,
      environment.base ?? HOSTILE_SERVER_ENVIRONMENT,
      environment.assignedConfigDirectory,
    );

    const { options } = yield* claudeCodeAdapterOptions({
      instanceId: CLAUDE_CODE_INSTANCE_ID,
      command: login.command,
      loginEnvironment: login.environment,
    });

    return yield* makeClaudeAdapter(settings, { ...options, createQuery });
  });
}

export const claudeCodeTestLayer = Layer.mergeAll(
  ServerConfig.layerTest("/tmp/claude-code-session-test", "/tmp"),
  ServerSettingsService.layerTest(),
).pipe(Layer.provideMerge(NodeServices.layer));

/**
 * A process that never answers, so the real SDK starts and then waits. Like
 * Claude Code, it exits when its input closes.
 */
class SilentProcess extends NodeEvents.EventEmitter implements SpawnedProcess {
  readonly stdin = new NodeStream.Writable({
    write: (_chunk, _encoding, callback) => callback(),
  });
  readonly stdout = new NodeStream.PassThrough();
  readonly killed = false;
  exitCode: number | null = null;

  constructor() {
    super();
    this.stdin.once("finish", () => this.exit());
  }

  kill(): boolean {
    this.exit();

    return true;
  }

  private exit(): void {
    if (this.exitCode !== null) return;

    this.exitCode = 0;
    this.stdout.end();
    this.emit("exit", 0, null);
  }
}

export function silentProcess(): SpawnedProcess {
  return new SilentProcess();
}

export const nextEvent = (
  events: Stream.Stream<ProviderRuntimeEvent>,
  type: ProviderRuntimeEvent["type"],
) =>
  events.pipe(
    Stream.filter((event) => event.type === type),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
