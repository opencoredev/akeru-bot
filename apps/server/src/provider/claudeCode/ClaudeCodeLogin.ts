/**
 * Claude Code login: Akeru runs the user's own installed `claude` program,
 * which uses the login the user made with `claude auth login`. Akeru never
 * reads that login. It asks the CLI for its version and login status and
 * passes nothing that would replace the login.
 *
 * @module provider/claudeCode/ClaudeCodeLogin
 */
import { type ClaudeSettings, ProviderDriverKind } from "@akeru/contracts";
import { resolveCommandPath, resolveSpawnCommand } from "@akeru/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess } from "effect/unstable/process";
import {
  query,
  type AccountInfo,
  type SDKUserMessage,
  type Options as ClaudeQueryOptions,
} from "@anthropic-ai/claude-agent-sdk";

import packageJson from "../../../package.json" with { type: "json" };
import { resolveClaudeSdkExecutablePath } from "../Drivers/ClaudeExecutable.ts";
import {
  claudeAuthMetadata,
  apiProviderAuthMetadata,
} from "../Layers/claude/ClaudeAuthMetadata.ts";
import {
  DEFAULT_CLAUDE_MODEL_CAPABILITIES,
  getBuiltInClaudeModelsForVersion,
} from "../Layers/claude/ClaudeModels.ts";
import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ProviderProbeResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

export const CLAUDE_CODE_DRIVER_KIND = ProviderDriverKind.make("claudeCode");

/** Overrides which `claude` program Akeru runs, like OpenCode's `OPENCODE_CLAUDE_PATH`. */
export const CLAUDE_CODE_PATH_ENV = "AKERU_CLAUDE_PATH";

/**
 * The only inherited variables Claude Code gets. Anything else could replace
 * or reroute the user's login: tokens and API keys, `ANTHROPIC_BASE_URL` and
 * custom headers, Bedrock, Vertex, and Foundry switches with their cloud
 * credentials, or `CLAUDE_CODE_SIMPLE`. The Windows names let a process start
 * and find the user's profile there; proxy and CA variables let it connect. Compared upper-case, since Windows names
 * are case-insensitive.
 */
const CLAUDE_CODE_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "USERNAME",
  "APPDATA",
  "LOCALAPPDATA",
  "HOMEDRIVE",
  "HOMEPATH",
  // Network transport only: proxies and certificate authorities, so a
  // corporate network still reaches Anthropic. They do not change the login.
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);

function isAllowedClaudeCodeVariable(name: string): boolean {
  const upper = name.toUpperCase();

  return CLAUDE_CODE_ENV_ALLOWLIST.has(upper) || upper.startsWith("LC_");
}

const CLAUDE_CODE_PRESENTATION = {
  displayName: "Claude Agent",
  showInteractionModeToggle: true,
} as const;

const CLAUDE_CODE_NOT_INSTALLED_MESSAGE =
  "Claude Code is not installed on this machine. Install it, then run `claude auth login`.";

const CLAUDE_CODE_LOGGED_OUT_MESSAGE =
  "Claude Code is not logged in. Run `claude auth login` on this machine, then verify.";

export type ClaudeCodeLoginState =
  | { readonly kind: "not-installed"; readonly command: string }
  | { readonly kind: "logged-out"; readonly executable: string; readonly version: string | null }
  | {
      readonly kind: "ready";
      readonly executable: string;
      readonly version: string | null;
      readonly authMethod: string | undefined;
      readonly subscriptionType: string | undefined;
      readonly apiProvider: string | undefined;
      readonly email: string | undefined;
    }
  | {
      readonly kind: "error";
      readonly executable: string;
      readonly version: string | null;
      readonly message: string;
    };

/** How long Claude Code may take to start and report its login. */
const LOGIN_PROBE_TIMEOUT = "30 seconds";

/**
 * Settings isolation shared by sessions and the login check: no settings
 * file, so no `env`, `apiKeyHelper`, or command hook can change what the
 * login looks like or run anything.
 */
export const CLAUDE_CODE_ISOLATED_QUERY_OPTIONS = {
  settingSources: [],
  settings: { disableAllHooks: true },
} as const satisfies Pick<ClaudeQueryOptions, "settingSources" | "settings">;

/** A login is any token or key Claude Code reports, as OpenCode's check reads it. */
function isLoggedIn(account: AccountInfo): boolean {
  return (
    (account.tokenSource !== undefined && account.tokenSource !== "none") ||
    account.apiKeySource !== undefined ||
    account.subscriptionType !== undefined ||
    (account.apiProvider !== undefined && account.apiProvider !== "firstParty")
  );
}

/**
 * Starts Claude Code through the SDK with the session's isolated settings and
 * reads the account from its initialize reply. No message is sent, so no model
 * request is made.
 */
const readClaudeCodeAccount = (executable: string, environment: NodeJS.ProcessEnv) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const stop = Promise.withResolvers<void>();

      // A prompt that never yields a message and ends when the check closes.
      const prompt: AsyncIterable<SDKUserMessage> = {
        [Symbol.asyncIterator]: () => ({
          next: () => stop.promise.then(() => ({ done: true as const, value: undefined })),
        }),
      };

      const session = query({
        prompt,
        options: {
          pathToClaudeCodeExecutable: executable,
          env: environment,
          persistSession: false,
          ...CLAUDE_CODE_ISOLATED_QUERY_OPTIONS,
        },
      });

      return { session, stop };
    }),
    ({ session }) =>
      Effect.tryPromise(() => session.initializationResult()).pipe(
        Effect.map((init) => init.account),
        Effect.timeoutOption(LOGIN_PROBE_TIMEOUT),
        Effect.result,
      ),
    ({ session, stop }) =>
      Effect.sync(() => {
        stop.resolve();
        session.close();
      }),
  );

/**
 * The command Akeru runs: the instance's binary path when the user changed it,
 * then `AKERU_CLAUDE_PATH`, then `claude` on PATH.
 */
export function claudeCodeCommand(
  settings: Pick<ClaudeSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv,
): string {
  const configured = settings.binaryPath.trim();

  if (configured.length > 0 && configured !== "claude") return configured;

  return environment[CLAUDE_CODE_PATH_ENV]?.trim() || "claude";
}

/**
 * The environment Claude Code runs with: only the allowlisted variables from
 * the server's and the instance's environment, the account's own
 * CLAUDE_CONFIG_DIR when it keeps a separate login, and Akeru's name through
 * the SDK client variable Anthropic documents for that.
 */
export function claudeCodeLoginEnvironment(
  base: NodeJS.ProcessEnv,
  options: { readonly claudeConfigDirectory?: string | undefined } = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};

  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && isAllowedClaudeCodeVariable(name)) environment[name] = value;
  }

  if (options.claudeConfigDirectory) {
    environment.CLAUDE_CONFIG_DIR = options.claudeConfigDirectory;
  }

  environment.CLAUDE_AGENT_SDK_CLIENT_APP = `akeru-bot/${packageJson.version}`;

  return environment;
}

const runClaudeCode = (
  executable: string,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const spawn = yield* resolveSpawnCommand(executable, args, { env: environment });

    return yield* spawnAndCollect(
      executable,
      ChildProcess.make(spawn.command, spawn.args, { env: environment, shell: spawn.shell }),
    );
  }).pipe(Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS), Effect.result);

/**
 * Checks the installed Claude Code and its login. It runs `claude --version`,
 * then starts Claude Code with settings isolated and reads its account; neither
 * sends a model request.
 */
export const probeClaudeCodeLogin = Effect.fn("probeClaudeCodeLogin")(function* (
  command: string,
  environment: NodeJS.ProcessEnv,
) {
  const executable = yield* resolveCommandPath(command, { env: environment }).pipe(Effect.option);

  if (Option.isNone(executable)) {
    return { kind: "not-installed", command } satisfies ClaudeCodeLoginState;
  }

  const failed = (version: string | null, message: string): ClaudeCodeLoginState => ({
    kind: "error",
    executable: executable.value,
    version,
    message,
  });

  const versionRun = yield* runClaudeCode(executable.value, ["--version"], environment);

  if (Result.isFailure(versionRun) || Option.isNone(versionRun.success)) {
    return failed(
      null,
      "Claude Code is installed but did not start. Run `claude --version` to see why.",
    );
  }

  const versionOutput = versionRun.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);

  if (versionOutput.code !== 0) {
    return failed(
      version,
      "Claude Code is installed but did not start. Run `claude --version` to see why.",
    );
  }

  const sdkExecutable = yield* resolveClaudeSdkExecutablePath(executable.value, environment);
  const accountRun = yield* readClaudeCodeAccount(sdkExecutable, environment);

  if (Result.isFailure(accountRun)) {
    return failed(
      version,
      "Claude Code did not start a session. Run `claude update`, then verify.",
    );
  }

  if (Option.isNone(accountRun.success)) {
    return failed(version, "Claude Code did not report its login in time. Try Verify again.");
  }

  const account = accountRun.success.value;

  if (!isLoggedIn(account)) {
    return {
      kind: "logged-out",
      executable: executable.value,
      version,
    } satisfies ClaudeCodeLoginState;
  }

  return {
    kind: "ready",
    executable: executable.value,
    version,
    authMethod: account.tokenSource ?? account.apiKeySource,
    subscriptionType: account.subscriptionType,
    apiProvider: account.apiProvider,
    email: account.email,
  } satisfies ClaudeCodeLoginState;
});

function probeResult(state: ClaudeCodeLoginState): ProviderProbeResult {
  switch (state.kind) {
    case "not-installed":
      return {
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: CLAUDE_CODE_NOT_INSTALLED_MESSAGE,
      };
    case "logged-out":
      return {
        installed: true,
        version: state.version,
        status: "error",
        auth: { status: "unauthenticated" },
        message: CLAUDE_CODE_LOGGED_OUT_MESSAGE,
      };
    case "error":
      return {
        installed: true,
        version: state.version,
        status: "error",
        auth: { status: "unknown" },
        message: state.message,
      };
    case "ready": {
      const metadata =
        claudeAuthMetadata({
          subscriptionType: state.subscriptionType,
          authMethod: state.authMethod,
        }) ?? apiProviderAuthMetadata(state.apiProvider);

      return {
        installed: true,
        version: state.version,
        status: "ready",
        auth: {
          status: "authenticated",
          ...(state.authMethod && !metadata ? { type: state.authMethod } : {}),
          ...metadata,
          ...(state.email ? { email: state.email } : {}),
        },
      };
    }

    default: {
      const _exhaustive: never = state;

      return _exhaustive;
    }
  }
}

/** The provider snapshot for one login check. Models follow the installed version. */
export const claudeCodeProviderDraft = Effect.fn("claudeCodeProviderDraft")(function* (
  settings: Pick<ClaudeSettings, "customModels" | "enabled">,
  state: ClaudeCodeLoginState | undefined,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const version = state && state.kind !== "not-installed" ? state.version : null;

  const models = providerModelsFromSettings(
    getBuiltInClaudeModelsForVersion(version),
    settings.customModels,
    DEFAULT_CLAUDE_MODEL_CAPABILITIES,
  );

  return buildServerProvider({
    driver: CLAUDE_CODE_DRIVER_KIND,
    presentation: CLAUDE_CODE_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models,
    probe: state
      ? probeResult(state)
      : {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Checking Claude Code on this machine.",
        },
  }) satisfies ServerProviderDraft;
});
