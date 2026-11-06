import type {
  ExecutionEnvironmentPlatformOs,
  ProviderInstanceConfig,
  ServerProvider,
} from "@akeru/contracts";
import * as Predicate from "effect/Predicate";

/**
 * Claude Code login: a Claude connection that runs the user's own installed
 * Claude Code with the login from `claude auth login`. Web and mobile read the
 * same steps from the instance's provider snapshot.
 */
export const CLAUDE_CODE_DRIVER = "claudeCode";

export const CLAUDE_CODE_INSTALL_URL = "https://code.claude.com/docs/en/setup";

export type ClaudeCodeLoginStep = "checking" | "not-installed" | "logged-out" | "ready" | "error";

export function isClaudeCodeProvider(
  provider: Pick<ServerProvider, "driver"> | undefined,
): boolean {
  return provider?.driver === CLAUDE_CODE_DRIVER;
}

/** Where the user is in setup, read from the snapshot the server published. */
export function claudeCodeLoginStep(
  provider: Pick<ServerProvider, "installed" | "status" | "auth"> | undefined,
): ClaudeCodeLoginStep {
  if (!provider) return "checking";

  if (provider.status === "ready") return "ready";

  if (provider.auth.status === "unauthenticated") return "logged-out";

  if (!provider.installed) return provider.status === "error" ? "not-installed" : "checking";

  return "error";
}

/** The shell the login command is written for: the environment machine's, not the client's. */
export type ClaudeCodeLoginShell = "posix" | "powershell";

export function claudeCodeLoginShell(
  os: ExecutionEnvironmentPlatformOs | undefined,
): ClaudeCodeLoginShell {
  return os === "windows" ? "powershell" : "posix";
}

/**
 * Where an account's Claude Code login lives, as the client can see it: the
 * default folder, a folder it can name, or a folder saved in a sensitive
 * variable whose value the server keeps hidden.
 */
export type ClaudeCodeConfigFolder =
  | { readonly kind: "default" }
  | { readonly kind: "folder"; readonly directory: string }
  | { readonly kind: "hidden" };

/**
 * The account's own Claude Code config folder: its config path, then a
 * CLAUDE_CONFIG_DIR variable on the account. A relative folder is shown under
 * `~`, where the server resolves it.
 */
export function claudeCodeConfigDirectory(
  instance: Pick<ProviderInstanceConfig, "config" | "environment"> | undefined,
): ClaudeCodeConfigFolder {
  const config = instance?.config;

  const homePath =
    Predicate.isObject(config) && "homePath" in config && Predicate.isString(config.homePath)
      ? config.homePath.trim()
      : "";

  const variable = homePath
    ? undefined
    : instance?.environment?.findLast(({ name }) => name === "CLAUDE_CONFIG_DIR");

  // A sensitive value reaches clients blank; the folder is set, just not shown.
  if (variable?.valueRedacted === true) return { kind: "hidden" };

  const raw = homePath || variable?.value.trim();

  if (!raw) return { kind: "default" };

  // The server reads a relative folder from the user's home, so the command does too.
  const absolute = raw.startsWith("/") || raw.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(raw);

  return {
    kind: "folder",
    directory:
      absolute || raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\")
        ? raw
        : `~/${raw.replace(/^\.[/\\]/, "")}`,
  };
}

/** The variable Claude Code reads its home folder from: USERPROFILE on Windows, HOME elsewhere. */
export type ClaudeCodeHomeVariable = "HOME" | "USERPROFILE";

/**
 * The home folder an account gives Claude Code, as the client can see it.
 * With no config folder, Claude Code keeps its login under this home.
 */
export type ClaudeCodeAccountHome =
  | { readonly kind: "default" }
  | { readonly kind: "home"; readonly variable: ClaudeCodeHomeVariable; readonly directory: string }
  | { readonly kind: "hidden"; readonly variable: ClaudeCodeHomeVariable };

/**
 * The account's own HOME, or USERPROFILE on Windows, where Windows ignores
 * the variable name's case. A blank value leaves the server's home, as on
 * the server.
 */
export function claudeCodeAccountHome(
  instance: Pick<ProviderInstanceConfig, "environment"> | undefined,
  shell: ClaudeCodeLoginShell,
): ClaudeCodeAccountHome {
  const variable: ClaudeCodeHomeVariable = shell === "powershell" ? "USERPROFILE" : "HOME";

  const entry = instance?.environment?.findLast(({ name }) =>
    shell === "powershell" ? name.toUpperCase() === variable : name === variable,
  );

  if (entry?.valueRedacted === true) return { kind: "hidden", variable };

  const directory = entry?.value.trim();

  return directory ? { kind: "home", variable, directory } : { kind: "default" };
}

/** The variable the server reads for the Claude Code program when the account sets no path. */
const CLAUDE_CODE_PATH_ENV = "AKERU_CLAUDE_PATH";

/**
 * The Claude Code program the server runs for this account: its binary path
 * setting, then an AKERU_CLAUDE_PATH variable on the account, then `claude`
 * from PATH, in the order the server resolves them.
 */
export function claudeCodeExecutable(
  instance: Pick<ProviderInstanceConfig, "config" | "environment"> | undefined,
): string {
  const config = instance?.config;

  const binaryPath =
    Predicate.isObject(config) && "binaryPath" in config && Predicate.isString(config.binaryPath)
      ? config.binaryPath.trim()
      : "";

  if (binaryPath.length > 0 && binaryPath !== "claude") return binaryPath;

  return (
    instance?.environment
      ?.findLast((variable) => variable.name === CLAUDE_CODE_PATH_ENV)
      ?.value.trim() || "claude"
  );
}

/** One POSIX shell word: single quotes, with each `'` closed, escaped, and reopened. */
function posixQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** One PowerShell literal: single quotes, with each `'` doubled. Nothing inside expands. */
function powerShellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** `<program> auth login`; PowerShell runs a quoted path only through the call operator. */
function claudeCodeLoginProgramCommand(executable: string, shell: ClaudeCodeLoginShell): string {
  const program =
    executable === "claude"
      ? "claude"
      : shell === "powershell"
        ? `& ${powerShellQuote(executable)}`
        : posixQuote(executable);

  return `${program} auth login`;
}

/** A leading `~` stays the user's home: it is the only part left outside the quotes. */
function splitHome(directory: string) {
  if (directory === "~") return { home: true, rest: "" };

  return directory.startsWith("~/") || directory.startsWith("~\\")
    ? { home: true, rest: directory.slice(1) }
    : { home: false, rest: directory };
}

/**
 * The command that logs Claude Code in, with the account's own program and
 * config folder when it has them. Paths are quoted so pasting runs nothing but
 * the login: `$`, `$(...)`, backticks, quotes, spaces, and newlines stay
 * literal. The default account clears CLAUDE_CONFIG_DIR, which a separate
 * account's PowerShell command leaves set, because the server ignores an
 * inherited one and checks Claude Code's default folder.
 */
export function claudeCodeLoginCommand(
  input: {
    readonly configDirectory?: string | undefined;
    /** The account's own home, used only when it has no config folder. */
    readonly homeDirectory?: string | undefined;
    readonly executable?: string | undefined;
    readonly shell?: ClaudeCodeLoginShell;
  } = {},
): string {
  const directory = input.configDirectory?.trim();
  const homeDirectory = input.homeDirectory?.trim();
  const executable = input.executable?.trim() || "claude";
  const shell = input.shell ?? "posix";

  const login = claudeCodeLoginProgramCommand(executable, shell);

  if (!directory) {
    if (shell === "powershell") {
      // The home applies to the login alone; the terminal gets its own back afterwards.
      const withHome = homeDirectory
        ? `$akeruUserProfile = $env:USERPROFILE; $env:USERPROFILE = ${powerShellQuote(homeDirectory)}; try { ${login} } finally { $env:USERPROFILE = $akeruUserProfile }`
        : login;

      return `$env:CLAUDE_CONFIG_DIR = $null; ${withHome}`;
    }

    return `(unset CLAUDE_CONFIG_DIR; ${homeDirectory ? `HOME=${posixQuote(homeDirectory)} ` : ""}${login})`;
  }

  const { home, rest } = splitHome(directory);

  if (shell === "powershell") {
    const value = home
      ? rest
        ? `(Join-Path $HOME ${powerShellQuote(rest.replace(/^[/\\]/, ""))})`
        : "$HOME"
      : powerShellQuote(directory);

    return `$env:CLAUDE_CONFIG_DIR = ${value}; ${login}`;
  }

  const value = home ? `"$HOME"${rest ? posixQuote(rest) : ""}` : posixQuote(directory);

  return `CLAUDE_CONFIG_DIR=${value} ${login}`;
}

/**
 * How a client tells the user to log one account in. `hidden-folder` means
 * the account's CLAUDE_CONFIG_DIR is saved as a sensitive value the client
 * cannot see: the user sets that variable themselves, then runs `command`,
 * which leaves CLAUDE_CONFIG_DIR as they set it. `hidden-home` is the same
 * for an account with no config folder whose `variable` (HOME or
 * USERPROFILE) is hidden; `command` leaves that variable as they set it.
 */
export type ClaudeCodeLoginInstruction =
  | { readonly kind: "command"; readonly command: string }
  | { readonly kind: "hidden-folder"; readonly command: string }
  | {
      readonly kind: "hidden-home";
      readonly variable: ClaudeCodeHomeVariable;
      readonly command: string;
    };

/**
 * The login instruction for one account on an environment, as every client
 * shows it. The program and config folder come from the provider snapshot
 * when the server published them, since only the server sees an inherited
 * AKERU_CLAUDE_PATH or the folder it assigned a separate account; older
 * servers fall back to the account's own settings.
 */
export function claudeCodeLoginCommandForInstance(input: {
  readonly instance: Pick<ProviderInstanceConfig, "config" | "environment"> | undefined;
  readonly provider: Pick<ServerProvider, "executable" | "configDirectory"> | undefined;
  readonly os: ExecutionEnvironmentPlatformOs | undefined;
}): ClaudeCodeLoginInstruction {
  const executable = input.provider?.executable ?? claudeCodeExecutable(input.instance);
  const shell = claudeCodeLoginShell(input.os);

  const folder: ClaudeCodeConfigFolder = input.provider?.configDirectory
    ? { kind: "folder", directory: input.provider.configDirectory }
    : claudeCodeConfigDirectory(input.instance);

  if (folder.kind === "hidden") {
    return { kind: "hidden-folder", command: claudeCodeLoginProgramCommand(executable, shell) };
  }

  if (folder.kind === "folder") {
    return {
      kind: "command",
      command: claudeCodeLoginCommand({ configDirectory: folder.directory, executable, shell }),
    };
  }

  // With no config folder, Claude Code keeps its login under the account's home.
  const home = claudeCodeAccountHome(input.instance, shell);

  if (home.kind === "hidden") {
    return {
      kind: "hidden-home",
      variable: home.variable,
      command: claudeCodeLoginCommand({ executable, shell }),
    };
  }

  return {
    kind: "command",
    command: claudeCodeLoginCommand({
      ...(home.kind === "home" ? { homeDirectory: home.directory } : {}),
      executable,
      shell,
    }),
  };
}

/** English catalog keys; clients translate them with their own translator. */
const CLAUDE_CODE_LOGIN_STEP_COPY = {
  checking: {
    title: "Checking Claude Code",
    detail: "Akeru is looking for Claude Code on this environment's machine.",
  },
  "not-installed": {
    title: "Install Claude Code",
    detail: "Claude Code is not installed on this environment's machine. Install it, then log in.",
  },
  "logged-out": {
    title: "Log in to Claude Code",
    detail: "Run this in a terminal on this environment's machine, then verify.",
  },
  ready: {
    title: "Claude Agent ready",
    detail: "Bots on this connection use your own Claude Code login.",
  },
  error: {
    title: "Claude Code needs attention",
    detail: "Akeru could not use Claude Code. Fix the problem below, then verify.",
  },
} as const satisfies Record<
  ClaudeCodeLoginStep,
  { readonly title: string; readonly detail: string }
>;

export function claudeCodeLoginStepCopy(step: ClaudeCodeLoginStep) {
  return CLAUDE_CODE_LOGIN_STEP_COPY[step];
}
