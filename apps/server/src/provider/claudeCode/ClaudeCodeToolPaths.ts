/**
 * Where a Claude Code tool call reaches on disk, for the bot permission
 * policy. This is best-effort on the user's own machine: a bot with shell
 * access can read whatever the user can, and no string check closes that.
 * Where parsing is uncertain the answer is the more cautious one. Real
 * isolation comes from running the bot in a sandbox workspace.
 *
 * @module provider/claudeCode/ClaudeCodeToolPaths
 */
import * as NodeURL from "node:url";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";

import type { SdkRecord } from "../Layers/ProtocolJson.ts";

export interface ClaudeCodeFileScope {
  /** The bot's workspace root. Writes may land only here. */
  readonly cwd: string | undefined;
  /** Extra folders the bot may read, such as chat attachments. */
  readonly readRoots: ReadonlyArray<string>;
  readonly homeDirectory: string;
  /** The account's CLAUDE_CONFIG_DIR, absolute, when it keeps its own login. */
  readonly claudeConfigDirectory: string | undefined;
  /** The host opens `.CLAUDE.JSON` as `.claude.json`, so protected paths match in any case. */
  readonly caseInsensitivePaths: boolean;
}

/**
 * Windows and default macOS (APFS) file systems ignore letter case. A
 * case-sensitive macOS volume only makes the protected-path check stricter.
 */
export function hostPathsAreCaseInsensitive(platform: NodeJS.Platform) {
  return platform === "win32" || platform === "darwin";
}

/**
 * - `inside`: the workspace, or the attachments folder for reads.
 * - `outside`: anywhere else, or a path that could not be resolved safely.
 * - `claude-config`: a path in Claude Code's own login or settings.
 * - `claude-config-shell`: a shell command that may reach them. It cannot be
 *   parsed with certainty, so it always needs the owner's answer.
 */
export type ClaudeCodePathReach = "inside" | "outside" | "claude-config" | "claude-config-shell";

/** The input keys that name a path, per Claude Code file tool. */
const PATH_KEYS: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
  ["Read", ["file_path"]],
  ["Write", ["file_path"]],
  ["Edit", ["file_path"]],
  ["MultiEdit", ["file_path"]],
  ["NotebookRead", ["notebook_path"]],
  ["NotebookEdit", ["notebook_path"]],
  ["Glob", ["path", "pattern"]],
  ["Grep", ["path"]],
  ["LS", ["path"]],
]);

/** Argument names MCP tools use for a path, such as a filesystem server's. */
const MCP_PATH_KEYS: ReadonlySet<string> = new Set([
  "path",
  "paths",
  "file",
  "files",
  "file_path",
  "filepath",
  "filename",
  "directory",
  "dir",
  "source",
  "destination",
  "target",
  "uri",
  "url",
]);

const WRITE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/**
 * Tools that walk every folder below their path, which defaults to the
 * workspace. A search rooted above Claude Code's files reaches them too.
 */
const RECURSIVE_SEARCH_TOOLS: ReadonlySet<string> = new Set(["Grep", "Glob"]);

/** Symlink hops allowed before a path counts as unresolvable, as in Linux. */
const MAX_SYMLINK_HOPS = 40;

/** A glob pattern names a place only when it is absolute, home-relative, or climbs out. */
function patternPlace(pattern: string): string | undefined {
  if (!(pattern.startsWith("/") || pattern.startsWith("~") || pattern.includes(".."))) {
    return undefined;
  }

  const firstGlob = pattern.search(/[*?[{]/);
  const prefix = firstGlob < 0 ? pattern : pattern.slice(0, firstGlob);

  return prefix.length > 0 ? prefix : undefined;
}

function fileToolPaths(toolName: string, input: SdkRecord): ReadonlyArray<string> {
  const keys = PATH_KEYS.get(toolName) ?? [];

  return keys.flatMap((key) => {
    const value = input[key];

    if (!Predicate.isString(value) || value.trim().length === 0) return [];

    if (key !== "pattern") return [value.trim()];

    const place = patternPlace(value.trim());

    return place ? [place] : [];
  });
}

/**
 * What one MCP path argument names. `unconvertible` is a `file:` URL that
 * does not convert to a path on this host; it is treated as protected.
 */
export type McpPathArgument =
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "none" }
  | { readonly kind: "unconvertible" };

/**
 * A path argument as the host would open it. `file:` URLs convert the way
 * Node does, decoding every escape, with drive letters and UNC hosts on
 * Windows. Other URLs name no file.
 */
export function mcpPathArgument(
  key: string,
  value: string,
  options: { readonly windows: boolean },
): McpPathArgument {
  const trimmed = value.trim();

  if (trimmed.length === 0) return { kind: "none" };

  if (/^file:/i.test(trimmed)) {
    try {
      return { kind: "path", path: NodeURL.fileURLToPath(trimmed, { windows: options.windows }) };
    } catch {
      return { kind: "unconvertible" };
    }
  }

  if (key === "uri" || key === "url" || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return { kind: "none" };
  }

  return { kind: "path", path: trimmed };
}

function mcpToolArguments(
  input: SdkRecord,
  options: { readonly windows: boolean },
): ReadonlyArray<McpPathArgument> {
  return Object.entries(input).flatMap(([key, value]) => {
    if (!MCP_PATH_KEYS.has(key.toLowerCase())) return [];

    const values = Array.isArray(value) ? value : [value];

    return values.flatMap((entry) =>
      Predicate.isString(entry) ? [mcpPathArgument(key.toLowerCase(), entry, options)] : [],
    );
  });
}

/**
 * Text that suggests a shell command reaches Claude Code's login or settings.
 * Shell can build a path many ways, so any mention of those names, or a
 * change to the home folder, counts.
 */
function shellMayReachClaudeConfig(command: string, scope: ClaudeCodeFileScope, path: Path.Path) {
  const fold = (value: string) => (scope.caseInsensitivePaths ? value.toLowerCase() : value);

  const configName = scope.claudeConfigDirectory
    ? path.basename(scope.claudeConfigDirectory)
    : undefined;

  const names = [
    ".claude",
    ".credentials",
    "CLAUDE_CONFIG_DIR",
    ...(scope.claudeConfigDirectory ? [scope.claudeConfigDirectory] : []),
    ...(configName && configName.length > 0 ? [configName] : []),
  ];

  if (names.some((name) => fold(command).includes(fold(name)))) return true;

  return folderChanges(command).some(changesToHomeOrUnknown);
}

/** Where a `cd` or `pushd` goes when it names the home folder itself. */
const HOME_DESTINATIONS: ReadonlySet<string> = new Set([
  "~",
  "~/",
  "$HOME",
  "$HOME/",
  "${HOME}",
  "${HOME}/",
]);

/**
 * The destination of every `cd` and `pushd` in a command, with simple quotes
 * removed. An empty string means no argument, which goes home.
 */
function folderChanges(command: string): ReadonlyArray<string> {
  const destinations: string[] = [];
  const change = /(^|[\s;&|(])(?:cd|pushd)(?=$|[\s;&|)])/g;

  for (const match of command.matchAll(change)) {
    let rest = command.slice((match.index ?? 0) + match[0].length);

    // Options such as `-P` come before the folder; `cd -` itself is a destination.
    for (;;) {
      const option = /^\s+-[LPe@]+(?=\s|$)/.exec(rest);

      if (!option) break;
      rest = rest.slice(option[0].length);
    }

    const argument = /^\s*((?:"[^"]*"|'[^']*'|\\.|[^\s;&|)])*)/.exec(rest)?.[1] ?? "";
    destinations.push(argument.replace(/^"(.*)"$|^'(.*)'$/s, "$1$2"));
  }

  return destinations;
}

/**
 * True when a folder change lands in the home folder, or somewhere the
 * classifier cannot tell: the previous folder (`cd -`), a command
 * substitution, or a variable other than HOME. A subfolder such as
 * `~/projects/x` follows the normal policy.
 */
function changesToHomeOrUnknown(destination: string): boolean {
  if (destination === "" || HOME_DESTINATIONS.has(destination)) return true;

  if (destination === "-" || /\$\(|`/.test(destination)) return true;

  const variables = [...destination.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].map(
    (variable) => variable[1],
  );

  return variables.some((name) => name !== "HOME");
}

/**
 * Where one call reaches. Claude Code's login and settings win over every
 * other answer. Every spelling of a path, lexical and physical, must stay
 * inside for the call to count as inside.
 */
export const claudeCodeToolPathReach = Effect.fn("claudeCodeToolPathReach")(function* (
  toolName: string,
  input: SdkRecord,
  scope: ClaudeCodeFileScope,
) {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;

  /**
   * The physical path, walking each component and following every symlink,
   * dangling ones included. Undefined when a component cannot be resolved
   * safely, such as a permission error or a symlink loop.
   */
  /** A path's components in order, empty parts dropped. Windows accepts either separator. */
  const components = (value: string) =>
    value.split(path.sep === "\\" ? /[\\/]/ : "/").filter(Boolean);

  const physicalPath = Effect.fn("claudeCodeToolPathReach.physicalPath")(function* (
    target: string,
  ) {
    // The raw components, `..` included: a `..` applies to the physical folder
    // its left side resolves to, so it is never folded in before a symlink.
    let resolved = path.parse(target).root;
    const pending = components(target.slice(resolved.length));
    let hops = 0;
    let missing = false;

    while (pending.length > 0) {
      const part = pending.shift() ?? "";

      if (part === ".") continue;

      if (part === "..") {
        // `resolved` is already physical here, so its parent is the real parent.
        resolved = path.dirname(resolved);
        missing = false;
        continue;
      }

      const candidate = path.join(resolved, part);

      // Below a missing component nothing exists, so nothing can be a symlink.
      if (missing) {
        resolved = candidate;
        continue;
      }

      const link = yield* fileSystem.readLink(candidate).pipe(Effect.result);

      if (Result.isSuccess(link)) {
        hops += 1;

        if (hops > MAX_SYMLINK_HOPS) return undefined;

        // The target's own components go first, raw; a relative target starts
        // from the folder that holds the link.
        const linkRoot = path.parse(link.success).root;

        if (path.isAbsolute(link.success)) resolved = linkRoot;
        pending.unshift(
          ...components(link.success.slice(path.isAbsolute(link.success) ? linkRoot.length : 0)),
        );
        continue;
      }

      if (Predicate.isTagged(link.failure.reason, "NotFound")) {
        missing = true;
        resolved = candidate;
        continue;
      }

      // Not a symlink: it must exist as a plain entry, or the path is unsafe.
      const info = yield* fileSystem.stat(candidate).pipe(Effect.result);

      if (Result.isFailure(info)) return undefined;

      resolved = candidate;
    }

    return resolved;
  });

  /** Both spellings of an absolute path, or undefined when it cannot be resolved. */
  const forms = Effect.fn("claudeCodeToolPathReach.forms")(function* (target: string) {
    const resolved = path.resolve(target);
    const physical = yield* physicalPath(target);

    if (physical === undefined) return undefined;

    return physical === resolved ? [resolved] : [resolved, physical];
  });

  const isWithin = (target: string, root: string) => {
    const relative = path.relative(root, target);

    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };

  /** Protected paths compare the way the host file system does. */
  const fold = (value: string) => (scope.caseInsensitivePaths ? value.toLowerCase() : value);
  const isProtectedWithin = (target: string, root: string) => isWithin(fold(target), fold(root));

  /** Roots are compared in every spelling they resolve to; an unresolvable root still counts lexically. */
  const rootForms = Effect.fn("claudeCodeToolPathReach.rootForms")(function* (
    roots: ReadonlyArray<string>,
  ) {
    const all = yield* Effect.forEach(roots, (root) =>
      forms(root).pipe(Effect.map((found) => found ?? [path.resolve(root)])),
    );

    return all.flat();
  });

  if (toolName === "Bash") {
    const command = input.command;

    return Predicate.isString(command) && shellMayReachClaudeConfig(command, scope, path)
      ? ("claude-config-shell" as const)
      : ("inside" as const);
  }

  const isMcpTool = toolName.startsWith("mcp__");
  const mcpArguments = isMcpTool ? mcpToolArguments(input, { windows: path.sep === "\\" }) : [];

  if (mcpArguments.some((argument) => argument.kind === "unconvertible")) {
    return "claude-config" as const;
  }

  const named = isMcpTool
    ? mcpArguments.flatMap((argument) => (argument.kind === "path" ? [argument.path] : []))
    : fileToolPaths(toolName, input);

  const searches = RECURSIVE_SEARCH_TOOLS.has(toolName);
  const raw = searches && named.length === 0 && scope.cwd ? [scope.cwd] : named;

  if (raw.length === 0) return "inside" as const;

  const configRoots = yield* rootForms([
    path.join(scope.homeDirectory, ".claude"),
    ...(scope.claudeConfigDirectory ? [scope.claudeConfigDirectory] : []),
  ]);

  const configFiles = yield* rootForms([path.join(scope.homeDirectory, ".claude.json")]);

  const roots = yield* rootForms([
    ...(scope.cwd ? [scope.cwd] : []),
    ...(WRITE_TOOLS.has(toolName) ? [] : scope.readRoots),
  ]);

  let reach: ClaudeCodePathReach = "inside";

  for (const value of raw) {
    const expanded =
      value === "~" || value.startsWith("~/") || value.startsWith("~\\")
        ? path.join(scope.homeDirectory, value.slice(1))
        : value;

    if (!path.isAbsolute(expanded) && !scope.cwd) {
      reach = "outside";
      continue;
    }

    // Joined without normalizing, so the walk sees every raw `..`.
    const absolute = path.isAbsolute(expanded) ? expanded : `${scope.cwd}${path.sep}${expanded}`;
    const found = yield* forms(absolute);
    const targets = found ?? [path.resolve(absolute)];

    const touchesConfig = targets.some(
      (target) =>
        configFiles.some((file) => fold(file) === fold(target)) ||
        configRoots.some((root) => isProtectedWithin(target, root)) ||
        (searches &&
          [...configRoots, ...configFiles].some((protectedPath) =>
            isProtectedWithin(protectedPath, target),
          )),
    );

    if (touchesConfig) return "claude-config" as const;

    // A path that cannot be resolved safely is never treated as inside.
    if (found === undefined) {
      reach = "outside";
      continue;
    }

    if (!targets.every((target) => roots.some((root) => isWithin(target, root)))) {
      reach = "outside";
    }
  }

  return reach;
});
