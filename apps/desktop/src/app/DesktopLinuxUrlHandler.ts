import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

// Linux ships as an AppImage, so the .desktop entry users end up with is
// created by whatever integration tool they use (AppImageLauncher names it
// appimagekit_<hash>-….desktop) and its filename is not under our control.
// Electron's app.setAsDefaultProtocolClient resolves the desktop id from
// setDesktopName, which cannot match those files — so the browser keeps
// prompting "Choose an application" for every OAuth callback. Instead, write
// our own handler entry pointing at the current AppImage and claim the
// scheme default via xdg-mime, exactly what the file manager's "set as
// default" checkbox would record in mimeapps.list.
export const URL_HANDLER_DESKTOP_ENTRY_NAME = "akeru-url-handler.desktop";

// Schemes older releases claimed for this same handler entry. Their defaults
// must be released on upgrade or t3code:// links keep launching Akeru.
export const RETIRED_URL_HANDLER_SCHEMES = ["t3code", "t3code-dev"] as const;

// Removes our handler entry from mimeapps.list associations for retired
// schemes, keeping any other application's handlers on the same line and
// dropping the line only when ours was the last one. Returns null when
// nothing changed.
export function removeRetiredSchemeAssociations(mimeappsContent: string): string | null {
  let changed = false;
  const retained = mimeappsContent.split("\n").flatMap((line) => {
    const match = /^x-scheme-handler\/([^=]+)=(.*)$/.exec(line.trim());
    if (match === null) return [line];
    const [, scheme, handlers] = match;
    if (!(RETIRED_URL_HANDLER_SCHEMES as readonly string[]).includes(scheme!)) {
      return [line];
    }
    const entries = handlers!.split(";").filter((handler) => handler.length > 0);
    const others = entries.filter((handler) => handler !== URL_HANDLER_DESKTOP_ENTRY_NAME);
    if (others.length === entries.length) {
      return [line];
    }
    changed = true;
    return others.length === 0 ? [] : [`x-scheme-handler/${scheme}=${others.join(";")};`];
  });
  return changed ? retained.join("\n") : null;
}

const { logInfo, logWarning } = makeComponentLogger("desktop-linux-url-handler");

export class DesktopLinuxUrlHandlerRegistrationError extends Schema.TaggedErrorClass<DesktopLinuxUrlHandlerRegistrationError>()(
  "DesktopLinuxUrlHandlerRegistrationError",
  {
    step: Schema.Literals(["write-desktop-entry", "set-default-handler"]),
    scheme: Schema.String,
    desktopEntryPath: Schema.optionalKey(Schema.String),
    exitCode: Schema.optionalKey(Schema.Number),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    const exitCode = this.exitCode === undefined ? "" : `, xdg-mime exit code ${this.exitCode}`;
    return `Failed to register the ${this.scheme}:// URL handler (step: ${this.step}${exitCode}).`;
  }
}

const isRegistrationError = Schema.is(DesktopLinuxUrlHandlerRegistrationError);

const escapeDesktopEntryString = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");

// Exec values are unescaped twice by implementations: first the general
// string-value rules, then the Exec quoting rules — so writing composes the
// layers in reverse. The argument is double-quoted with reserved characters
// backslash-escaped and literal percent signs doubled (field codes), and the
// general string escaping is applied on top: a literal backslash ends up as
// four backslashes in the file, a quote as \\", a dollar sign as \\$.
export function escapeDesktopEntryExecArgument(value: string): string {
  const quoted = value
    .replaceAll("\\", () => "\\\\")
    .replaceAll("`", () => "\\`")
    .replaceAll("$", () => "\\$")
    .replaceAll('"', () => '\\"')
    .replaceAll("%", () => "%%");
  return escapeDesktopEntryString(`"${quoted}"`);
}

// The AppImage integration entry owns the window identity and icon. This
// hidden URL-only entry must not compete with it for StartupWMClass matching.
export function renderUrlHandlerDesktopEntry(input: {
  readonly displayName: string;
  readonly execTarget: string;
  readonly schemes: ReadonlyArray<string>;
}): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${escapeDesktopEntryString(input.displayName)}`,
    `Exec=${escapeDesktopEntryExecArgument(input.execTarget)} %U`,
    "Terminal=false",
    "NoDisplay=true",
    "StartupNotify=false",
    `MimeType=${input.schemes.map((scheme) => `x-scheme-handler/${scheme};`).join("")}`,
    "",
  ].join("\n");
}

export class DesktopLinuxUrlHandler extends Context.Service<
  DesktopLinuxUrlHandler,
  {
    readonly register: Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopLinuxUrlHandler") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const scheme = ElectronProtocol.getDesktopScheme(environment.isDevelopment);
  const schemes = [scheme];
  const desktopEntryPath = environment.path.join(
    environment.linuxApplicationsDir,
    URL_HANDLER_DESKTOP_ENTRY_NAME,
  );

  const writeDesktopEntry = Effect.gen(function* () {
    // Inside the mounted AppImage, process.execPath points at a transient
    // /tmp/.mount_* path — the handler must launch the AppImage itself.
    const execTarget = Option.getOrElse(environment.appImagePath, () => process.execPath);
    yield* fileSystem.makeDirectory(environment.linuxApplicationsDir, { recursive: true });
    yield* fileSystem.writeFileString(
      desktopEntryPath,
      renderUrlHandlerDesktopEntry({
        displayName: environment.displayName,
        execTarget,
        schemes,
      }),
    );
  }).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopLinuxUrlHandlerRegistrationError({
          step: "write-desktop-entry",
          scheme,
          desktopEntryPath,
          cause,
        }),
    ),
  );

  const setDefaultHandler = (scheme: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const command = ChildProcess.make(
          "xdg-mime",
          ["default", URL_HANDLER_DESKTOP_ENTRY_NAME, `x-scheme-handler/${scheme}`],
          {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          },
        );
        const handle = yield* spawner.spawn(command);
        const exitCode = yield* handle.exitCode;
        if ((exitCode as unknown as number) !== 0) {
          return yield* new DesktopLinuxUrlHandlerRegistrationError({
            step: "set-default-handler",
            scheme,
            exitCode: Number(exitCode),
          });
        }
      }),
    ).pipe(
      Effect.mapError((error) =>
        isRegistrationError(error)
          ? error
          : new DesktopLinuxUrlHandlerRegistrationError({
              step: "set-default-handler",
              scheme,
              cause: error,
            }),
      ),
    );

  // On Linux, appDataDirectory is XDG_CONFIG_HOME — where xdg-mime records
  // per-user defaults. Only associations that point at our own handler entry
  // are removed, so a real T3 install's claims stay intact.
  const releaseRetiredSchemes = Effect.gen(function* () {
    const mimeappsPath = environment.path.join(environment.appDataDirectory, "mimeapps.list");
    const content = yield* fileSystem.readFileString(mimeappsPath);
    const cleaned = removeRetiredSchemeAssociations(content);
    if (cleaned === null) {
      return;
    }
    yield* fileSystem.writeFileString(mimeappsPath, cleaned);
    yield* logInfo("released retired URL scheme defaults", {
      schemes: RETIRED_URL_HANDLER_SCHEMES,
    });
  }).pipe(
    // Best-effort like the rest of registration; a missing mimeapps.list is
    // the common case on fresh installs.
    Effect.ignore,
  );

  const register = Effect.gen(function* () {
    if (environment.platform !== "linux" || !environment.isPackaged) {
      return;
    }
    yield* writeDesktopEntry;
    yield* Effect.forEach(schemes, setDefaultHandler, { discard: true });
    yield* releaseRetiredSchemes;
    yield* logInfo("registered URL scheme handlers", { schemes });
  }).pipe(
    // Registration is best-effort: a missing xdg-mime or read-only home must
    // never block startup — the OS chooser remains as fallback.
    Effect.catch((error) =>
      logWarning("URL scheme handler registration failed", {
        scheme: error.scheme,
        step: error.step,
        message: error.message,
        ...(error.desktopEntryPath === undefined
          ? {}
          : { desktopEntryPath: error.desktopEntryPath }),
        ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
      }),
    ),
    Effect.withSpan("desktop.linuxUrlHandler.register"),
  );

  return DesktopLinuxUrlHandler.of({ register });
});

export const layer = Layer.effect(DesktopLinuxUrlHandler, make);
