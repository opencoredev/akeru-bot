import { describe, expect, it } from "vite-plus/test";

import {
  claudeCodeAccountHome,
  claudeCodeConfigDirectory,
  claudeCodeExecutable,
  claudeCodeLoginCommand,
  claudeCodeLoginCommandForInstance,
  claudeCodeLoginShell,
  claudeCodeLoginStep,
} from "./claudeCodeLogin.ts";

type NodeModules = {
  readonly fs: {
    mkdtempSync(prefix: string): string;
    writeFileSync(path: string, data: string, options: { mode: number }): void;
    readFileSync(path: string, encoding: "utf8"): string;
    readdirSync(path: string): string[];
  };
  readonly child_process: {
    execFileSync(
      file: string,
      args: ReadonlyArray<string>,
      options: {
        readonly cwd: string;
        readonly env: Readonly<Record<string, string>>;
        readonly encoding: "utf8";
      },
    ): string;
  };
  readonly os: { tmpdir(): string };
};

const node = (
  globalThis as typeof globalThis & {
    process: { getBuiltinModule<K extends keyof NodeModules>(id: K): NodeModules[K] };
  }
).process;

const fs = node.getBuiltinModule("fs");

const childProcess = node.getBuiltinModule("child_process");

const os = node.getBuiltinModule("os");

/**
 * Pastes the command into a real shell with a fake `claude` first on PATH,
 * and returns the CLAUDE_CONFIG_DIR that `claude` saw plus any files the
 * paste created besides that.
 */
function runPasted(
  shell: "sh" | "bash",
  command: string,
  inherited: Readonly<Record<string, string>> = {},
  seenVariable: "CLAUDE_CONFIG_DIR" | "HOME" = "CLAUDE_CONFIG_DIR",
) {
  const directory = fs.mkdtempSync(`${os.tmpdir()}/akeru-login-command-`);
  fs.writeFileSync(
    `${directory}/claude`,
    `#!/bin/sh\nprintf '%s' "$${seenVariable}" > '${directory}/seen'\n`,
    { mode: 0o755 },
  );

  childProcess.execFileSync(shell, ["-c", command], {
    cwd: directory,
    env: { ...inherited, PATH: `${directory}:/usr/bin:/bin`, HOME: "/home/akeru-user" },
    encoding: "utf8",
  });

  return {
    seen: fs.readFileSync(`${directory}/seen`, "utf8"),
    extraFiles: fs.readdirSync(directory).filter((name) => name !== "claude" && name !== "seen"),
  };
}

const HOSTILE_DIRECTORIES = [
  "/srv/claude $HOME",
  "/srv/claude-$(touch pwned)",
  "/srv/claude-`touch pwned`",
  '/srv/it\'s "quoted"',
  "/srv/with space/and\nnewline",
  "/srv/semi; touch pwned",
];

describe("claudeCodeLoginStep", () => {
  it("reads each setup step from the provider snapshot", () => {
    expect(claudeCodeLoginStep(undefined)).toBe("checking");
    expect(
      claudeCodeLoginStep({ installed: false, status: "warning", auth: { status: "unknown" } }),
    ).toBe("checking");
    expect(
      claudeCodeLoginStep({ installed: false, status: "error", auth: { status: "unknown" } }),
    ).toBe("not-installed");
    expect(
      claudeCodeLoginStep({
        installed: true,
        status: "error",
        auth: { status: "unauthenticated" },
      }),
    ).toBe("logged-out");
    expect(
      claudeCodeLoginStep({ installed: true, status: "error", auth: { status: "unknown" } }),
    ).toBe("error");
    expect(
      claudeCodeLoginStep({ installed: true, status: "ready", auth: { status: "authenticated" } }),
    ).toBe("ready");
  });
});

describe("claudeCodeLoginCommand", () => {
  it("clears an inherited CLAUDE_CONFIG_DIR without a config folder", () => {
    expect(claudeCodeLoginCommand()).toBe("(unset CLAUDE_CONFIG_DIR; claude auth login)");
    expect(claudeCodeLoginCommand({ configDirectory: "  ", shell: "powershell" })).toBe(
      "$env:CLAUDE_CONFIG_DIR = $null; claude auth login",
    );

    for (const shell of ["sh", "bash"] as const) {
      const pasted = runPasted(shell, claudeCodeLoginCommand(), {
        CLAUDE_CONFIG_DIR: "/srv/other-account",
      });

      expect(pasted).toEqual({ seen: "", extraFiles: [] });
    }
  });

  it.each(["sh", "bash"] as const)("passes hostile paths to %s literally", (shell) => {
    for (const configDirectory of HOSTILE_DIRECTORIES) {
      const pasted = runPasted(shell, claudeCodeLoginCommand({ configDirectory }));

      expect(pasted.seen).toBe(configDirectory);
      expect(pasted.extraFiles).toEqual([]);
    }
  });

  it("keeps a leading ~ as the user's home", () => {
    expect(
      runPasted("sh", claudeCodeLoginCommand({ configDirectory: "~/.claude-work" })).seen,
    ).toBe("/home/akeru-user/.claude-work");
    expect(
      runPasted("sh", claudeCodeLoginCommand({ configDirectory: "~/x $(touch pwned)" })),
    ).toEqual({ seen: "/home/akeru-user/x $(touch pwned)", extraFiles: [] });
  });

  it("writes PowerShell literals for a Windows environment", () => {
    expect(
      claudeCodeLoginCommand({
        configDirectory: "C:\\Claude $(Get-Item) `n it's",
        shell: "powershell",
      }),
    ).toBe("$env:CLAUDE_CONFIG_DIR = 'C:\\Claude $(Get-Item) `n it''s'; claude auth login");
    expect(
      claudeCodeLoginCommand({ configDirectory: "~\\.claude-work", shell: "powershell" }),
    ).toBe("$env:CLAUDE_CONFIG_DIR = (Join-Path $HOME '.claude-work'); claude auth login");
    expect(claudeCodeLoginShell("windows")).toBe("powershell");
    expect(claudeCodeLoginShell("darwin")).toBe("posix");
    expect(claudeCodeLoginShell(undefined)).toBe("posix");
  });
});

describe("claudeCodeExecutable", () => {
  it("uses the account's binary path, then its AKERU_CLAUDE_PATH variable, then claude", () => {
    expect(claudeCodeExecutable(undefined)).toBe("claude");
    expect(claudeCodeExecutable({ config: { binaryPath: "claude" } })).toBe("claude");
    expect(
      claudeCodeExecutable({
        config: { binaryPath: " /opt/claude/bin/claude " },
        environment: [{ name: "AKERU_CLAUDE_PATH", value: "/ignored", sensitive: false }],
      }),
    ).toBe("/opt/claude/bin/claude");
    expect(
      claudeCodeExecutable({
        config: { binaryPath: "claude" },
        environment: [{ name: "AKERU_CLAUDE_PATH", value: "/srv/claude", sensitive: false }],
      }),
    ).toBe("/srv/claude");
  });

  it("runs the account's own program when the command is pasted", () => {
    const directory = fs.mkdtempSync(`${os.tmpdir()}/akeru-login-binary-`);
    const executable = `${directory}/my claude's $(touch pwned)`;
    fs.writeFileSync(executable, `#!/bin/sh\nprintf '%s' "$*" > '${directory}/seen'\n`, {
      mode: 0o755,
    });

    const { command } = claudeCodeLoginCommandForInstance({
      instance: { config: { binaryPath: executable, homePath: "/srv/claude" } },
      provider: undefined,
      os: "linux",
    });

    childProcess.execFileSync("sh", ["-c", command], {
      cwd: directory,
      env: { PATH: "/usr/bin:/bin", HOME: "/home/akeru-user" },
      encoding: "utf8",
    });

    expect(fs.readFileSync(`${directory}/seen`, "utf8")).toBe("auth login");
    expect(fs.readdirSync(directory).toSorted()).toEqual([`my claude's $(touch pwned)`, "seen"]);
  });

  it("runs the program the server published, such as an inherited AKERU_CLAUDE_PATH", () => {
    expect(
      claudeCodeLoginCommandForInstance({
        instance: { config: {} },
        provider: { executable: "/opt/claude bin/claude" },
        os: "linux",
      }),
    ).toEqual({
      kind: "command",
      command: "(unset CLAUDE_CONFIG_DIR; '/opt/claude bin/claude' auth login)",
    });
    expect(
      claudeCodeLoginCommandForInstance({
        instance: { config: {} },
        provider: {},
        os: "linux",
      }),
    ).toEqual({ kind: "command", command: "(unset CLAUDE_CONFIG_DIR; claude auth login)" });
  });

  it("logs a separate account into the folder the server assigned it", () => {
    const assigned = "/home/me/.akeru/userdata/providers/claude-code/claude-work";

    expect(
      claudeCodeLoginCommandForInstance({
        instance: { config: {} },
        provider: { configDirectory: assigned },
        os: "linux",
      }),
    ).toEqual({ kind: "command", command: `CLAUDE_CONFIG_DIR='${assigned}' claude auth login` });
    expect(
      claudeCodeLoginCommandForInstance({
        instance: { config: { homePath: "~/stale" } },
        provider: { configDirectory: "C:\\Akeru\\claude-work" },
        os: "windows",
      }),
    ).toEqual({
      kind: "command",
      command: "$env:CLAUDE_CONFIG_DIR = 'C:\\Akeru\\claude-work'; claude auth login",
    });
  });

  it("gives manual steps instead of the default command when the folder is hidden", () => {
    const instance = {
      config: {},
      environment: [{ name: "CLAUDE_CONFIG_DIR", value: "", sensitive: true, valueRedacted: true }],
    };

    expect(claudeCodeConfigDirectory(instance)).toEqual({ kind: "hidden" });
    expect(claudeCodeLoginCommandForInstance({ instance, provider: {}, os: "linux" })).toEqual({
      kind: "hidden-folder",
      command: "claude auth login",
    });
    expect(
      claudeCodeLoginCommandForInstance({
        instance,
        provider: { executable: "C:\\Tools\\claude.exe" },
        os: "windows",
      }),
    ).toEqual({ kind: "hidden-folder", command: "& 'C:\\Tools\\claude.exe' auth login" });
  });

  it("calls a quoted program through the PowerShell call operator", () => {
    expect(
      claudeCodeLoginCommand({
        executable: "C:\\Tools\\claude it's.exe",
        shell: "powershell",
      }),
    ).toBe("$env:CLAUDE_CONFIG_DIR = $null; & 'C:\\Tools\\claude it''s.exe' auth login");
  });
});

describe("claudeCodeConfigDirectory", () => {
  it("uses the account's config path, then its CLAUDE_CONFIG_DIR variable", () => {
    expect(claudeCodeConfigDirectory(undefined)).toEqual({ kind: "default" });
    expect(
      claudeCodeConfigDirectory({
        config: { homePath: "~/.claude-work" },
        environment: [{ name: "CLAUDE_CONFIG_DIR", value: "/ignored", sensitive: false }],
      }),
    ).toEqual({ kind: "folder", directory: "~/.claude-work" });
    expect(
      claudeCodeConfigDirectory({
        environment: [{ name: "CLAUDE_CONFIG_DIR", value: "/srv/claude", sensitive: false }],
      }),
    ).toEqual({ kind: "folder", directory: "/srv/claude" });
  });

  it("shows a relative folder under the home folder, where the server resolves it", () => {
    const instance = {
      environment: [{ name: "CLAUDE_CONFIG_DIR", value: "claude-work", sensitive: false }],
    };

    expect(claudeCodeConfigDirectory(instance)).toEqual({
      kind: "folder",
      directory: "~/claude-work",
    });
    expect(claudeCodeConfigDirectory({ config: { homePath: "./second" } })).toEqual({
      kind: "folder",
      directory: "~/second",
    });
    expect(claudeCodeConfigDirectory({ config: { homePath: "C:\\Claude" } })).toEqual({
      kind: "folder",
      directory: "C:\\Claude",
    });
    expect(runPasted("sh", claudeCodeLoginCommand({ configDirectory: "~/claude-work" })).seen).toBe(
      "/home/akeru-user/claude-work",
    );
  });
});

describe("Claude Code login with the account's own home", () => {
  const withHome = (name: string, value: string, redacted = false) => ({
    config: {},
    environment: [
      { name, value, sensitive: redacted, ...(redacted ? { valueRedacted: true } : {}) },
    ],
  });

  it.each(["sh", "bash"] as const)(
    "logs %s in under the account's HOME, read literally",
    (shell) => {
      for (const home of ["/srv/claude-user", ...HOSTILE_DIRECTORIES]) {
        const login = claudeCodeLoginCommandForInstance({
          instance: withHome("HOME", home),
          provider: {},
          os: "linux",
        });

        expect(login.kind).toBe("command");

        const pasted = runPasted(shell, login.command, {}, "HOME");

        expect(pasted.seen).toBe(home);
        expect(pasted.extraFiles).toEqual([]);
      }
    },
  );

  it("sets USERPROFILE for the PowerShell login only, whatever its case", () => {
    const instance = withHome("UserProfile", "D:\\Claude User");

    expect(claudeCodeAccountHome(instance, "powershell")).toEqual({
      kind: "home",
      variable: "USERPROFILE",
      directory: "D:\\Claude User",
    });
    expect(claudeCodeLoginCommandForInstance({ instance, provider: {}, os: "windows" })).toEqual({
      kind: "command",
      command:
        "$env:CLAUDE_CONFIG_DIR = $null; $akeruUserProfile = $env:USERPROFILE; $env:USERPROFILE = 'D:\\Claude User'; try { claude auth login } finally { $env:USERPROFILE = $akeruUserProfile }",
    });
  });

  it("names the hidden home variable instead of guessing its value", () => {
    expect(
      claudeCodeLoginCommandForInstance({
        instance: withHome("HOME", "", true),
        provider: {},
        os: "linux",
      }),
    ).toEqual({
      kind: "hidden-home",
      variable: "HOME",
      command: "(unset CLAUDE_CONFIG_DIR; claude auth login)",
    });
    expect(
      claudeCodeLoginCommandForInstance({
        instance: withHome("USERPROFILE", "", true),
        provider: {},
        os: "windows",
      }),
    ).toEqual({
      kind: "hidden-home",
      variable: "USERPROFILE",
      command: "$env:CLAUDE_CONFIG_DIR = $null; claude auth login",
    });
  });

  it("leaves the home alone when a config folder decides where the login lives", () => {
    expect(
      claudeCodeLoginCommandForInstance({
        instance: withHome("HOME", "/srv/claude-user"),
        provider: { configDirectory: "/srv/claude-work" },
        os: "linux",
      }),
    ).toEqual({
      kind: "command",
      command: "CLAUDE_CONFIG_DIR='/srv/claude-work' claude auth login",
    });
    expect(claudeCodeAccountHome(withHome("HOME", "  "), "posix")).toEqual({ kind: "default" });
    expect(claudeCodeAccountHome(withHome("USERPROFILE", "C:\\x"), "posix")).toEqual({
      kind: "default",
    });
  });
});
