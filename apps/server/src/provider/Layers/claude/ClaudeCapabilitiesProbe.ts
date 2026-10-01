import { type ClaudeSettings, type ServerProviderSlashCommand } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import {
  query as claudeQuery,
  type Options as ClaudeQueryOptions,
  type SlashCommand as ClaudeSlashCommand,
  type SDKUserMessage,
  type SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import { resolveClaudeSdkExecutablePath } from "../../Drivers/ClaudeExecutable.ts";
import { makeClaudeEnvironment } from "../../Drivers/ClaudeHome.ts";

// ── SDK capability probe ────────────────────────────────────────────

// Amazon Bedrock initializes far slower than first-party auth: the SDK boots the
// Bedrock backend and runs the `awsAuthRefresh` credential hook before returning
// account info. The previous 8s budget expired mid-init, so the probe returned
// `undefined` and left the provider unverified and unselectable in the picker.
export const CAPABILITIES_PROBE_TIMEOUT_MS = 25_000;

/**
 * Keep workspace-scoped command discovery intact while isolating the periodic
 * health check from configured MCP servers.
 */
export const CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES = [
  "user",
  "project",
  "local",
] as const satisfies ReadonlyArray<SettingSource>;

/** Build the exact SDK options used by the periodic Claude capability probe. */
export function buildClaudeCapabilitiesProbeQueryOptions(input: {
  readonly executablePath: string;
  readonly abortController: AbortController;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string | undefined;
}): ClaudeQueryOptions {
  return {
    persistSession: false,
    pathToClaudeCodeExecutable: input.executablePath,
    abortController: input.abortController,
    settingSources: [...CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES],
    // The probe keeps filesystem setting sources for slash-command discovery,
    // but must not run the user's hooks: it fires every few minutes, so
    // SessionStart hooks would run on every health check.
    settings: { disableAllHooks: true },
    allowedTools: [],
    // Ignore MCP definitions from every filesystem setting source above. The
    // SDK combines this empty explicit map with --strict-mcp-config.
    mcpServers: {},
    strictMcpConfig: true,
    env: {
      ...input.environment,
      // Connected claude.ai MCP servers are discovered outside filesystem
      // config; disable them independently for this health check.
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    },
    ...(input.cwd ? { cwd: input.cwd } : {}),
    stderr: () => {},
  };
}

export function nonEmptyProbeString(value: string): string | undefined {
  const candidate = value.trim();

  return candidate ? candidate : undefined;
}

export type ClaudeCapabilitiesProbe = {
  readonly email: string | undefined;
  readonly subscriptionType: string | undefined;
  readonly tokenSource: string | undefined;
  /**
   * Active API backend reported by the SDK's `AccountInfo`. Anthropic OAuth
   * login only applies when `"firstParty"`; for Amazon Bedrock (`"bedrock"`)
   * the subscription/token fields are absent and auth is external AWS creds.
   */
  readonly apiProvider: string | undefined;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
};

export function parseClaudeInitializationCommands(
  commands: ReadonlyArray<ClaudeSlashCommand> | undefined,
): ReadonlyArray<ServerProviderSlashCommand> {
  return dedupeSlashCommands(
    (commands ?? []).flatMap((command) => {
      const name = nonEmptyProbeString(command.name);

      if (!name) {
        return [];
      }

      const description = nonEmptyProbeString(command.description);
      const argumentHint = nonEmptyProbeString(command.argumentHint);

      return [
        {
          name,
          ...(description ? { description } : {}),
          ...(argumentHint ? { input: { hint: argumentHint } } : {}),
        } satisfies ServerProviderSlashCommand,
      ];
    }),
  );
}

export function dedupeSlashCommands(
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const commandsByName = new Map<string, ServerProviderSlashCommand>();

  for (const command of commands) {
    const name = nonEmptyProbeString(command.name);

    if (!name) {
      continue;
    }

    const key = name.toLowerCase();
    const existing = commandsByName.get(key);

    if (!existing) {
      commandsByName.set(key, {
        ...command,
        name,
      });
      continue;
    }

    commandsByName.set(key, {
      ...existing,
      ...(existing.description
        ? {}
        : command.description
          ? { description: command.description }
          : {}),
      ...(existing.input?.hint
        ? {}
        : command.input?.hint
          ? { input: { hint: command.input.hint } }
          : {}),
    });
  }

  return [...commandsByName.values()];
}

export function waitForAbortSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Probe account information by spawning a lightweight Claude Agent SDK
 * session and reading the initialization result.
 *
 * We pass a never-yielding AsyncIterable as the prompt so that no user
 * message is ever written to the subprocess stdin. This means the Claude
 * Code subprocess completes its local initialization IPC (returning
 * account info and slash commands) but never starts an API request to
 * Anthropic. We read the init data and then abort the subprocess.
 *
 * This is used as a fallback when `claude auth status` does not include
 * subscription type information.
 */
export const probeClaudeCapabilities = (
  claudeSettings: ClaudeSettings,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
) => {
  const abort = new AbortController();

  return Effect.gen(function* () {
    const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);

    const executablePath = yield* resolveClaudeSdkExecutablePath(
      claudeSettings.binaryPath,
      claudeEnvironment,
    );

    return yield* Effect.tryPromise(async () => {
      const q = claudeQuery({
        // Never yield — we only need initialization data, not a conversation.
        // This prevents any prompt from reaching the Anthropic API.
        // oxlint-disable-next-line require-yield
        prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
          await waitForAbortSignal(abort.signal);
        })(),
        options: buildClaudeCapabilitiesProbeQueryOptions({
          executablePath,
          abortController: abort,
          environment: claudeEnvironment,
          cwd,
        }),
      });

      const init = await q.initializationResult();

      const account = init.account as
        | {
            readonly email?: string;
            readonly subscriptionType?: string;
            readonly tokenSource?: string;
            readonly apiProvider?: string;
          }
        | undefined;

      return {
        email: account?.email,
        subscriptionType: account?.subscriptionType,
        tokenSource: account?.tokenSource,
        apiProvider: account?.apiProvider,
        slashCommands: parseClaudeInitializationCommands(init.commands),
      } satisfies ClaudeCapabilitiesProbe;
    });
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (!abort.signal.aborted) abort.abort();
      }),
    ),
    Effect.timeoutOption(CAPABILITIES_PROBE_TIMEOUT_MS),
    Effect.result,
    Effect.map((result) => {
      if (Result.isFailure(result)) return undefined;

      return Option.isSome(result.success) ? result.success.value : undefined;
    }),
  );
};
