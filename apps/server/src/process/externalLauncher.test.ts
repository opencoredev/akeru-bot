
import { testLayer } from "./testUtils/externalLauncher.ts";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import { HostProcessPlatform } from "@akeru/shared/hostProcess";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/unstable/process";
import * as ExternalLauncher from "./externalLauncher.ts";

it.effect("reveals a file in Finder with open -R on macOS", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
    const openPath = path.join(binDir, "open");
    yield* fileSystem.writeFileString(openPath, "#!/bin/sh\n");
    yield* fileSystem.chmod(openPath, 0o755);

    let spawned: ChildProcess.StandardCommand | undefined;
    yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      yield* launcher.launchEditor({
        editor: "file-manager",
        cwd: "/workspace/media/linux-mini-v2.mp4",
        reveal: true,
      });
    }).pipe(
      Effect.provide(
        testLayer({
          platform: "darwin",
          env: { PATH: binDir },
          onSpawn: (command) => {
            spawned = command;
          },
        }),
      ),
    );

    assert.ok(spawned);
    assert.equal(spawned.command, "open");
    assert.deepEqual(spawned.args, ["-R", "/workspace/media/linux-mini-v2.mp4"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reveals a file in File Explorer through PowerShell on Windows", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
    yield* fileSystem.writeFileString(path.join(binDir, "explorer.CMD"), "@echo off\r\n");
    // resolvePowerShellPath builds `${SYSTEMROOT}\System32\...` with Windows
    // separators, which on the posix test filesystem is one file name.
    const systemRoot = path.join(binDir, "system-root");
    const powerShellPath = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    yield* fileSystem.makeDirectory(path.dirname(powerShellPath), { recursive: true });
    yield* fileSystem.writeFileString(powerShellPath, "");

    let spawned: ChildProcess.StandardCommand | undefined;

    const kind = yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      yield* launcher.launchEditor({
        editor: "file-manager",
        cwd: "C:\\workspace with spaces\\media\\author's clip.mp4",
        reveal: true,
      });

      return yield* launcher.resolveFileManagerRevealKind();
    }).pipe(
      Effect.provide(
        testLayer({
          platform: "win32",
          env: { PATH: binDir, PATHEXT: ".COM;.EXE;.BAT;.CMD", SYSTEMROOT: systemRoot },
          onSpawn: (command) => {
            spawned = command;
          },
        }),
      ),
    );

    assert.equal(kind, "file-explorer");
    assert.ok(spawned);
    assert.equal(spawned.command, powerShellPath);
    assert.deepEqual(spawned.args.slice(0, -1), [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
    ]);
    const encodedCommand = spawned.args[spawned.args.length - 1] ?? "";
    const decodedCommand = Buffer.from(encodedCommand, "base64").toString("utf16le");
    // explorer.exe expects `/select,"<path>"` with only the path quoted;
    // PowerShell 5.1's Start-Process passes the argument string verbatim.
    assert.equal(
      decodedCommand,
      "$ProgressPreference = 'SilentlyContinue'; Start-Process 'explorer.exe' -ArgumentList ('/select,\"' + 'C:\\workspace with spaces\\media\\author''s clip.mp4' + '\"')",
    );
    assert.equal(spawned.options.shell, false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// Real-chain smoke check for the Explorer selection contract: runs the exact
// PowerShell source the reveal launch encodes, against a stub that records
// the raw argument tail it receives, and asserts a spaced path arrives as the
// single `/select,"<path>"` switch. Mock argv assertions cannot prove this —
// only Windows' own PowerShell -> CreateProcess quoting chain can, so the
// test runs only where that chain exists.
async function runWindowsRevealSmoke() {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-reveal-smoke-"));

  try {
    const recorderPath = NodePath.join(tempDir, "recorder.cmd");
    const outputPath = NodePath.join(tempDir, "argv.txt");
    NodeFS.writeFileSync(recorderPath, `@echo off\r\n>"${outputPath}" echo(%*\r\n`);

    const target = "C:\\workspace with spaces\\media\\author's clip.mp4";
    const source = ExternalLauncher.buildFileExplorerRevealPowerShellSource(recorderPath, target);
    const powerShellPath = `${process.env.SYSTEMROOT ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    NodeChildProcess.execFileSync(
      powerShellPath,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        Buffer.from(source, "utf16le").toString("base64"),
      ],
      { timeout: 30_000 },
    );

    // Start-Process returns before the recorder runs; wait for its output.
    // The waits run outside the Effect runtime on purpose: the test
    // exercises the real Windows process chain in real time.
    const sleep = (millis: number) => new Promise((resolve) => setTimeout(resolve, millis));
    const deadline = Date.now() + 20_000;

    while (!NodeFS.existsSync(outputPath) && Date.now() < deadline) {
      await sleep(100);
    }

    await sleep(200);
    const recorded = NodeFS.readFileSync(outputPath, "utf8").trim();
    assert.equal(recorded, `/select,"${target}"`);
  } finally {
    NodeFS.rmSync(tempDir, { recursive: true, force: true });
  }
}

it.skipIf(HostProcessPlatform.defaultValue() !== "win32")(
  "delivers the raw /select switch for spaced paths through real PowerShell",
  { timeout: 60_000 },
  runWindowsRevealSmoke,
);

it.effect("does not advertise reveal on Windows when PowerShell is missing", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
    yield* fileSystem.writeFileString(path.join(binDir, "explorer.CMD"), "@echo off\r\n");

    const result = yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;

      return {
        kind: yield* launcher.resolveFileManagerRevealKind(),
        editors: yield* launcher.resolveAvailableEditors(),
      };
    }).pipe(
      Effect.provide(
        testLayer({
          platform: "win32",
          env: {
            PATH: binDir,
            PATHEXT: ".COM;.EXE;.BAT;.CMD",
            SYSTEMROOT: path.join(binDir, "missing-system-root"),
          },
        }),
      ),
    );

    // Plain "open in file manager" still works through explorer; only the
    // reveal capability, which launches PowerShell, must stay hidden.
    assert.equal(result.editors.includes("file-manager"), true);
    assert.isUndefined(result.kind);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reveals a WSL file in Windows File Explorer through its UNC path", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });

    for (const name of ["explorer.exe", "powershell.exe", "xdg-open"]) {
      const filePath = path.join(binDir, name);
      yield* fileSystem.writeFileString(filePath, "#!/bin/sh\n");
      yield* fileSystem.chmod(filePath, 0o755);
    }

    let spawned: ChildProcess.StandardCommand | undefined;

    const result = yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      const kind = yield* launcher.resolveFileManagerRevealKind();
      const editors = yield* launcher.resolveAvailableEditors();
      yield* launcher.launchEditor({
        editor: "file-manager",
        cwd: "/home/t3/workspace/media/clip.mp4",
        reveal: true,
      });

      return { kind, editors };
    }).pipe(
      Effect.provide(
        testLayer({
          platform: "linux",
          env: {
            PATH: binDir,
            WSL_DISTRO_NAME: "Ubuntu-24.04",
            WSL_INTEROP: "/run/WSL/1_interop",
          },
          onSpawn: (command) => {
            spawned = command;
          },
        }),
      ),
    );

    assert.equal(result.kind, "file-explorer");
    assert.equal(result.editors.includes("file-manager"), true);
    assert.ok(spawned);
    // The reveal routes through interop PowerShell so Explorer receives its
    // raw `/select,"<path>"` switch even for spaced paths.
    assert.equal(spawned.command, "powershell.exe");
    const encodedCommand = spawned.args[spawned.args.length - 1] ?? "";
    const decodedCommand = Buffer.from(encodedCommand, "base64").toString("utf16le");
    assert.equal(
      decodedCommand,
      "$ProgressPreference = 'SilentlyContinue'; Start-Process 'explorer.exe' -ArgumentList ('/select,\"' + '\\\\wsl.localhost\\Ubuntu-24.04\\home\\t3\\workspace\\media\\clip.mp4' + '\"')",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not advertise reveal from WSL when interop PowerShell is missing", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
    const explorerPath = path.join(binDir, "explorer.exe");
    yield* fileSystem.writeFileString(explorerPath, "");
    yield* fileSystem.chmod(explorerPath, 0o755);

    const result = yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;

      return {
        kind: yield* launcher.resolveFileManagerRevealKind(),
        editors: yield* launcher.resolveAvailableEditors(),
      };
    }).pipe(
      Effect.provide(
        testLayer({
          platform: "linux",
          env: {
            PATH: binDir,
            WSL_DISTRO_NAME: "Ubuntu-24.04",
            WSL_INTEROP: "/run/WSL/1_interop",
          },
        }),
      ),
    );

    assert.equal(result.editors.includes("file-manager"), true);
    assert.isUndefined(result.kind);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// When interop PowerShell is missing the capability advertises the Linux
// "files" kind (or nothing), so the reveal must open the Linux file manager
// the label promised even though plain open still prefers File Explorer.
it.effect("reveals through the Linux file manager when WSL lacks interop PowerShell", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });

    for (const name of ["explorer.exe", "xdg-open", "xdg-mime"]) {
      const filePath = path.join(binDir, name);
      yield* fileSystem.writeFileString(filePath, "#!/bin/sh\n");
      yield* fileSystem.chmod(filePath, 0o755);
    }

    const spawnedCommands: ChildProcess.StandardCommand[] = [];

    const kind = yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      const revealKind = yield* launcher.resolveFileManagerRevealKind();
      yield* launcher.launchEditor({
        editor: "file-manager",
        cwd: "/home/t3/workspace/media/clip.mp4",
        reveal: true,
      });

      return revealKind;
    }).pipe(
      Effect.provide(
        testLayer({
          platform: "linux",
          env: {
            PATH: binDir,
            WSL_DISTRO_NAME: "Ubuntu-24.04",
            WSL_INTEROP: "/run/WSL/1_interop",
            DISPLAY: ":0",
          },
          onSpawn: (command) => {
            spawnedCommands.push(command);
          },
          spawnResult: (command) =>
            command.command === "xdg-mime" ? { stdout: "org.gnome.Nautilus.desktop\n" } : undefined,
        }),
      ),
    );

    assert.equal(kind, "files");
    const launch = spawnedCommands.find((command) => command.command === "xdg-open");
    assert.ok(launch);
    assert.deepEqual(launch.args, ["/home/t3/workspace/media"]);
    assert.isUndefined(spawnedCommands.find((command) => command.command === "explorer.exe"));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// Interop can exist without `explorer.exe` on PATH (appendWindowsPath=false)
// while WSLg still provides a working Linux file manager; the host must keep
// the Linux open/reveal path instead of losing the editor entirely.
it.effect("falls back to the Linux file manager when WSL lacks the Explorer bridge", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });

    for (const name of ["xdg-open", "xdg-mime"]) {
      const filePath = path.join(binDir, name);
      yield* fileSystem.writeFileString(filePath, "#!/bin/sh\n");
      yield* fileSystem.chmod(filePath, 0o755);
    }

    const spawnedCommands: ChildProcess.StandardCommand[] = [];

    const result = yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      const editors = yield* launcher.resolveAvailableEditors();
      const kind = yield* launcher.resolveFileManagerRevealKind();
      yield* launcher.launchEditor({
        editor: "file-manager",
        cwd: "/home/t3/workspace/media/clip.mp4",
        reveal: true,
      });

      return { editors, kind };
    }).pipe(
      Effect.provide(
        testLayer({
          platform: "linux",
          env: {
            PATH: binDir,
            WSL_DISTRO_NAME: "Ubuntu-24.04",
            WSL_INTEROP: "/run/WSL/1_interop",
            DISPLAY: ":0",
          },
          onSpawn: (command) => {
            spawnedCommands.push(command);
          },
          spawnResult: (command) =>
            command.command === "xdg-mime" ? { stdout: "org.gnome.Nautilus.desktop\n" } : undefined,
        }),
      ),
    );

    assert.equal(result.editors.includes("file-manager"), true);
    assert.equal(result.kind, "files");
    const launch = spawnedCommands.find((command) => command.command === "xdg-open");
    assert.ok(launch);
    assert.deepEqual(launch.args, ["/home/t3/workspace/media"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "falls back to opening the containing directory for WSL paths Explorer cannot select",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });

      for (const name of ["explorer.exe", "powershell.exe"]) {
        const filePath = path.join(binDir, name);
        yield* fileSystem.writeFileString(filePath, "#!/bin/sh\n");
        yield* fileSystem.chmod(filePath, 0o755);
      }

      let spawned: ChildProcess.StandardCommand | undefined;
      yield* Effect.gen(function* () {
        const launcher = yield* ExternalLauncher.ExternalLauncher;
        yield* launcher.launchEditor({
          editor: "file-manager",
          cwd: '/home/t3/work "quoted"/clip.mp4',
          reveal: true,
        });
      }).pipe(
        Effect.provide(
          testLayer({
            platform: "linux",
            env: {
              PATH: binDir,
              WSL_DISTRO_NAME: "Ubuntu-24.04",
              WSL_INTEROP: "/run/WSL/1_interop",
            },
            onSpawn: (command) => {
              spawned = command;
            },
          }),
        ),
      );

      // Explorer's raw switch cannot express a double quote, so the launch
      // opens the parent directory instead of misparsing a /select argument.
      assert.ok(spawned);
      assert.equal(spawned.command, "explorer.exe");
      assert.deepEqual(spawned.args, ['\\\\wsl.localhost\\Ubuntu-24.04\\home\\t3\\work "quoted"']);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reveals by opening the containing directory on Linux", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });

    for (const name of ["xdg-open", "xdg-mime"]) {
      const filePath = path.join(binDir, name);
      yield* fileSystem.writeFileString(filePath, "#!/bin/sh\n");
      yield* fileSystem.chmod(filePath, 0o755);
    }

    const spawnedCommands: ChildProcess.StandardCommand[] = [];
    yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      yield* launcher.launchEditor({
        editor: "file-manager",
        cwd: "/workspace/media/linux-mini-v2.mp4",
        reveal: true,
      });
    }).pipe(
      Effect.provide(
        testLayer({
          platform: "linux",
          env: { PATH: binDir, DISPLAY: ":0" },
          onSpawn: (command) => {
            spawnedCommands.push(command);
          },
          spawnResult: (command) =>
            command.command === "xdg-mime" ? { stdout: "org.gnome.Nautilus.desktop\n" } : undefined,
        }),
      ),
    );

    const spawned = spawnedCommands.find((command) => command.command === "xdg-open");
    assert.ok(spawned);
    assert.deepEqual(spawned.args, ["/workspace/media"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not advertise a Linux file manager without a graphical session", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
    const xdgOpenPath = path.join(binDir, "xdg-open");
    yield* fileSystem.writeFileString(xdgOpenPath, "#!/bin/sh\n");
    yield* fileSystem.chmod(xdgOpenPath, 0o755);

    const editors = yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;

      return yield* launcher.resolveAvailableEditors();
    }).pipe(Effect.provide(testLayer({ platform: "linux", env: { PATH: binDir } })));

    assert.equal(editors.includes("file-manager"), false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("advertises a Linux file manager when a directory handler is installed", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });

    for (const name of ["xdg-open", "xdg-mime"]) {
      const filePath = path.join(binDir, name);
      yield* fileSystem.writeFileString(filePath, "#!/bin/sh\n");
      yield* fileSystem.chmod(filePath, 0o755);
    }

    let probe: ChildProcess.StandardCommand | undefined;

    const editors = yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;

      return yield* launcher.resolveAvailableEditors();
    }).pipe(
      Effect.provide(
        testLayer({
          platform: "linux",
          env: { PATH: binDir, DISPLAY: ":0" },
          onSpawn: (command) => {
            probe = command;
          },
          spawnResult: (command) =>
            command.command === "xdg-mime" ? { stdout: "org.gnome.Nautilus.desktop\n" } : undefined,
        }),
      ),
    );

    assert.equal(editors.includes("file-manager"), true);
    assert.ok(probe);
    assert.equal(probe.command, "xdg-mime");
    assert.deepEqual(probe.args, ["query", "default", "inode/directory"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// `xdg-open` with a display variable but no `inode/directory` handler exits
// nonzero after the launch has already detached: without this gate the server
// advertises a reveal that is a silent no-op.
it.effect("does not advertise a Linux file manager without a directory handler", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });

    for (const name of ["xdg-open", "xdg-mime"]) {
      const filePath = path.join(binDir, name);
      yield* fileSystem.writeFileString(filePath, "#!/bin/sh\n");
      yield* fileSystem.chmod(filePath, 0o755);
    }

    const editors = yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;

      return yield* launcher.resolveAvailableEditors();
    }).pipe(
      Effect.provide(
        testLayer({
          platform: "linux",
          env: { PATH: binDir, DISPLAY: ":0" },
          spawnResult: (command) => (command.command === "xdg-mime" ? { stdout: "" } : undefined),
        }),
      ),
    );

    assert.equal(editors.includes("file-manager"), false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not advertise a Linux file manager when the handler query fails", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });

    for (const name of ["xdg-open", "xdg-mime"]) {
      const filePath = path.join(binDir, name);
      yield* fileSystem.writeFileString(filePath, "#!/bin/sh\n");
      yield* fileSystem.chmod(filePath, 0o755);
    }

    const editors = yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;

      return yield* launcher.resolveAvailableEditors();
    }).pipe(
      Effect.provide(
        testLayer({
          platform: "linux",
          env: { PATH: binDir, DISPLAY: ":0" },
          spawnResult: (command) =>
            command.command === "xdg-mime"
              ? { exitCode: 47, stdout: "org.gnome.Nautilus.desktop\n" }
              : undefined,
        }),
      ),
    );

    assert.equal(editors.includes("file-manager"), false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// The handler probe carries its own timeout because the editor scan's outer
// timeout in server.getConfig degrades to an EMPTY editor list: a wedged
// xdg-mime must cost only the file manager, never the other editors. Runs on
// the live clock so the probe's real timeout fires.
it.live("a stalled handler probe drops only the file manager", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });

    for (const name of ["xdg-open", "xdg-mime", "code"]) {
      const filePath = path.join(binDir, name);
      yield* fileSystem.writeFileString(filePath, "#!/bin/sh\n");
      yield* fileSystem.chmod(filePath, 0o755);
    }

    const editors = yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;

      return yield* launcher.resolveAvailableEditors();
    }).pipe(
      Effect.provide(
        testLayer({
          platform: "linux",
          env: { PATH: binDir, DISPLAY: ":0" },
          spawnResult: (command) => (command.command === "xdg-mime" ? { stall: true } : undefined),
        }),
      ),
    );

    assert.equal(editors.includes("vscode"), true);
    assert.equal(editors.includes("file-manager"), false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not advertise a Linux file manager when xdg-mime is missing", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
    const xdgOpenPath = path.join(binDir, "xdg-open");
    yield* fileSystem.writeFileString(xdgOpenPath, "#!/bin/sh\n");
    yield* fileSystem.chmod(xdgOpenPath, 0o755);

    const editors = yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;

      return yield* launcher.resolveAvailableEditors();
    }).pipe(Effect.provide(testLayer({ platform: "linux", env: { PATH: binDir, DISPLAY: ":0" } })));

    assert.equal(editors.includes("file-manager"), false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
