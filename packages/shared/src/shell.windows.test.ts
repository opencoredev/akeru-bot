import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { HostProcessPlatform } from "@akeru/shared/hostProcess";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  listLoginShellCandidates,
  mergePathEntries,
  mergePathValues,
  readEnvironmentFromWindowsShell,
  resolveKnownWindowsCliDirs,
  resolveSpawnCommand,
  resolveWindowsEnvironment,
  SpawnExecutableResolution,
} from "./shell.ts";
import { withWindowsEnvironmentMocks } from "./shell.test-support.ts";

describe("listLoginShellCandidates", () => {
  it("returns env shell, user shell, then the platform fallback without duplicates", () => {
    expect(listLoginShellCandidates("darwin", " /opt/homebrew/bin/nu ", "/bin/zsh")).toEqual([
      "/opt/homebrew/bin/nu",
      "/bin/zsh",
    ]);
  });

  it("falls back to the platform default when no shells are available", () => {
    expect(listLoginShellCandidates("linux", undefined, "")).toEqual(["/bin/bash"]);
  });
});

describe("mergePathEntries", () => {
  it("uses the platform-specific delimiter", () => {
    expect(mergePathEntries("C:\\Tools;C:\\Windows", "C:\\Windows;C:\\Git", "win32")).toBe(
      "C:\\Tools;C:\\Windows;C:\\Git",
    );
  });
});

describe("readEnvironmentFromWindowsShell", () => {
  it("extracts environment variables from a PowerShell command", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(
      () =>
        "__T3CODE_ENV_PATH_START__\nC:\\Users\\testuser\\AppData\\Roaming\\npm\n__T3CODE_ENV_PATH_END__\n",
    );

    expect(readEnvironmentFromWindowsShell(["PATH"], execFile)).toEqual({
      PATH: "C:\\Users\\testuser\\AppData\\Roaming\\npm",
    });
    expect(execFile).toHaveBeenCalledWith(
      "pwsh.exe",
      expect.arrayContaining(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]),
      { encoding: "utf8", timeout: 5000 },
    );
  });

  it("strips CRLF delimiters from captured PowerShell values", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(
      () =>
        "__T3CODE_ENV_FNM_DIR_START__\r\nC:\\Users\\testuser\\AppData\\Roaming\\fnm\r\n__T3CODE_ENV_FNM_DIR_END__\r\n",
    );

    expect(readEnvironmentFromWindowsShell(["FNM_DIR"], execFile)).toEqual({
      FNM_DIR: "C:\\Users\\testuser\\AppData\\Roaming\\fnm",
    });
  });

  it("omits -NoProfile when loadProfile is enabled", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() => "__T3CODE_ENV_PATH_START__\nC:\\Tools\n__T3CODE_ENV_PATH_END__\n");

    expect(readEnvironmentFromWindowsShell(["PATH"], { loadProfile: true }, execFile)).toEqual({
      PATH: "C:\\Tools",
    });
    expect(execFile).toHaveBeenCalledWith(
      "pwsh.exe",
      expect.arrayContaining(["-NoLogo", "-NonInteractive", "-Command"]),
      { encoding: "utf8", timeout: 5000 },
    );
    expect(execFile.mock.calls[0]?.[1]).not.toContain("-NoProfile");
  });

  it("falls back to Windows PowerShell when pwsh.exe is unavailable", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >((file) => {
      if (file === "pwsh.exe") {
        throw new Error("spawn pwsh.exe ENOENT");
      }

      return "__T3CODE_ENV_PATH_START__\nC:\\Tools\n__T3CODE_ENV_PATH_END__\n";
    });

    expect(readEnvironmentFromWindowsShell(["PATH"], execFile)).toEqual({
      PATH: "C:\\Tools",
    });
    expect(execFile).toHaveBeenNthCalledWith(1, "pwsh.exe", expect.any(Array), {
      encoding: "utf8",
      timeout: 5000,
    });
    expect(execFile).toHaveBeenNthCalledWith(2, "powershell.exe", expect.any(Array), {
      encoding: "utf8",
      timeout: 5000,
    });
  });
});

describe("mergePathValues", () => {
  it("dedupes case-insensitively on Windows while preserving preferred order", () => {
    expect(
      mergePathValues(
        'C:\\Users\\testuser\\AppData\\Roaming\\npm;"C:\\Program Files\\nodejs"',
        "c:\\users\\testuser\\appdata\\roaming\\npm;C:\\Windows\\System32",
        "win32",
      ),
    ).toBe(
      'C:\\Users\\testuser\\AppData\\Roaming\\npm;"C:\\Program Files\\nodejs";C:\\Windows\\System32',
    );
  });
});

describe("resolveKnownWindowsCliDirs", () => {
  it("returns known Windows CLI install directories in priority order", () => {
    expect(
      resolveKnownWindowsCliDirs({
        APPDATA: "C:\\Users\\testuser\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\testuser\\AppData\\Local",
        USERPROFILE: "C:\\Users\\testuser",
      }),
    ).toEqual([
      "C:\\Users\\testuser\\AppData\\Roaming\\npm",
      "C:\\Users\\testuser\\AppData\\Local\\Programs\\nodejs",
      "C:\\Users\\testuser\\AppData\\Local\\Volta\\bin",
      "C:\\Users\\testuser\\AppData\\Local\\pnpm",
      "C:\\Users\\testuser\\.local\\bin",
      "C:\\Users\\testuser\\.bun\\bin",
      "C:\\Users\\testuser\\scoop\\shims",
    ]);
  });
});

effectIt.layer(NodeServices.layer)("resolveSpawnCommand", (it) => {
  it.effect("runs Windows executables directly without a shell", () =>
    Effect.gen(function* () {
      const command = yield* resolveSpawnCommand("node.exe", ["script.js", "hello & goodbye"], {
        env: { PATH: "", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      }).pipe(Effect.provideService(HostProcessPlatform, "win32"));

      expect(command).toEqual({
        command: "node.exe",
        args: ["script.js", "hello & goodbye"],
        shell: false,
      });
    }),
  );

  it.effect("escapes the executable and arguments for Windows command shims", () =>
    Effect.gen(function* () {
      const command = yield* resolveSpawnCommand(
        "vp",
        ["run", "value & calc", "%PATH%", 'quote"value'],
        { env: { PATH: "", PATHEXT: ".COM;.EXE;.BAT;.CMD" } },
      ).pipe(
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.provideService(
          SpawnExecutableResolution,
          () => "C:\\Program Files\\npm & tools\\vp.cmd",
        ),
      );

      expect(command.shell).toBe(true);
      expect(command.command).not.toContain(" & ");
      expect(command.command).toContain("^&");
      expect(command.args).toEqual([
        '^"run^"',
        '^"value^ ^&^ calc^"',
        '^"^%PATH^%^"',
        '^"quote\\^"value^"',
      ]);
    }),
  );

  it.effect("does not fall back to a shell for unresolved Windows commands", () =>
    Effect.gen(function* () {
      const command = yield* resolveSpawnCommand("missing & calc", ["unsafe & value"], {
        env: { PATH: "", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      }).pipe(Effect.provideService(HostProcessPlatform, "win32"));

      expect(command).toEqual({
        command: "missing & calc",
        args: ["unsafe & value"],
        shell: false,
      });
    }),
  );
});

effectIt.layer(NodeServices.layer)("resolveWindowsEnvironment", (it) => {
  it.effect("returns the baseline no-profile PATH patch when node is already available", () =>
    Effect.gen(function* () {
      const readEnvironment = vi.fn(
        (_names: ReadonlyArray<string>, options?: { loadProfile?: boolean }) =>
          options?.loadProfile
            ? { PATH: "C:\\Profile\\Bin" }
            : { PATH: "C:\\Shell\\Bin;C:\\Windows\\System32" },
      );

      const commandAvailable = vi.fn(() => Effect.succeed(true));

      expect(
        yield* withWindowsEnvironmentMocks(
          resolveWindowsEnvironment({
            PATH: "C:\\Windows\\System32",
            APPDATA: "C:\\Users\\testuser\\AppData\\Roaming",
            LOCALAPPDATA: "C:\\Users\\testuser\\AppData\\Local",
            USERPROFILE: "C:\\Users\\testuser",
          }),
          readEnvironment,
          commandAvailable,
        ),
      ).toEqual({
        PATH: [
          "C:\\Users\\testuser\\AppData\\Roaming\\npm",
          "C:\\Users\\testuser\\AppData\\Local\\Programs\\nodejs",
          "C:\\Users\\testuser\\AppData\\Local\\Volta\\bin",
          "C:\\Users\\testuser\\AppData\\Local\\pnpm",
          "C:\\Users\\testuser\\.local\\bin",
          "C:\\Users\\testuser\\.bun\\bin",
          "C:\\Users\\testuser\\scoop\\shims",
          "C:\\Shell\\Bin",
          "C:\\Windows\\System32",
        ].join(";"),
      });
      expect(readEnvironment).toHaveBeenCalledTimes(1);
      expect(readEnvironment).toHaveBeenCalledWith(["PATH"], { loadProfile: false });
      expect(commandAvailable).toHaveBeenCalledWith(
        "node",
        expect.objectContaining({ env: expect.any(Object) }),
      );
    }),
  );

  it.effect("loads the PowerShell profile when baseline env cannot resolve node", () =>
    Effect.gen(function* () {
      const readEnvironment = vi.fn(
        (_names: ReadonlyArray<string>, options?: { loadProfile?: boolean }) =>
          options?.loadProfile
            ? {
                PATH: "C:\\Profile\\Node;C:\\Windows\\System32",
                FNM_DIR: "C:\\Users\\testuser\\AppData\\Roaming\\fnm",
                FNM_MULTISHELL_PATH: "C:\\Users\\testuser\\AppData\\Local\\fnm_multishells\\123",
              }
            : { PATH: "C:\\Shell\\Bin;C:\\Windows\\System32" },
      );

      const commandAvailable = vi.fn(() => Effect.succeed(false));

      expect(
        yield* withWindowsEnvironmentMocks(
          resolveWindowsEnvironment({
            PATH: "C:\\Windows\\System32",
            APPDATA: "C:\\Users\\testuser\\AppData\\Roaming",
            LOCALAPPDATA: "C:\\Users\\testuser\\AppData\\Local",
            USERPROFILE: "C:\\Users\\testuser",
          }),
          readEnvironment,
          commandAvailable,
        ),
      ).toEqual({
        PATH: [
          "C:\\Profile\\Node",
          "C:\\Windows\\System32",
          "C:\\Users\\testuser\\AppData\\Roaming\\npm",
          "C:\\Users\\testuser\\AppData\\Local\\Programs\\nodejs",
          "C:\\Users\\testuser\\AppData\\Local\\Volta\\bin",
          "C:\\Users\\testuser\\AppData\\Local\\pnpm",
          "C:\\Users\\testuser\\.local\\bin",
          "C:\\Users\\testuser\\.bun\\bin",
          "C:\\Users\\testuser\\scoop\\shims",
          "C:\\Shell\\Bin",
        ].join(";"),
        FNM_DIR: "C:\\Users\\testuser\\AppData\\Roaming\\fnm",
        FNM_MULTISHELL_PATH: "C:\\Users\\testuser\\AppData\\Local\\fnm_multishells\\123",
      });
      expect(readEnvironment).toHaveBeenNthCalledWith(1, ["PATH"], { loadProfile: false });
      expect(readEnvironment).toHaveBeenNthCalledWith(
        2,
        ["PATH", "FNM_DIR", "FNM_MULTISHELL_PATH"],
        {
          loadProfile: true,
        },
      );
      expect(commandAvailable).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("keeps the baseline env when profiled probe still does not resolve node", () =>
    Effect.gen(function* () {
      const readEnvironment = vi.fn(
        (_names: ReadonlyArray<string>, options?: { loadProfile?: boolean }) =>
          options?.loadProfile ? { FNM_DIR: "C:\\Users\\testuser\\AppData\\Roaming\\fnm" } : {},
      );

      const commandAvailable = vi.fn(() => Effect.succeed(false));

      expect(
        yield* withWindowsEnvironmentMocks(
          resolveWindowsEnvironment({
            PATH: "C:\\Windows\\System32",
            APPDATA: "C:\\Users\\testuser\\AppData\\Roaming",
            USERPROFILE: "C:\\Users\\testuser",
          }),
          readEnvironment,
          commandAvailable,
        ),
      ).toEqual({
        PATH: [
          "C:\\Users\\testuser\\AppData\\Roaming\\npm",
          "C:\\Users\\testuser\\.local\\bin",
          "C:\\Users\\testuser\\.bun\\bin",
          "C:\\Users\\testuser\\scoop\\shims",
          "C:\\Windows\\System32",
        ].join(";"),
        FNM_DIR: "C:\\Users\\testuser\\AppData\\Roaming\\fnm",
      });
      expect(commandAvailable).toHaveBeenCalledTimes(1);
    }),
  );
});
