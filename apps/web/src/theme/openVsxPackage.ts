import * as Predicate from "effect/Predicate";
import JSZip from "jszip";
import {
  MAX_VSIX_BYTES,
  MAX_THEMES_PER_EXTENSION,
  isRecord,
  parseJsoncObject,
  readCappedResponse,
} from "./openVsxMetadata";

const MAX_THEME_BYTES = 256 * 1024;

const MAX_ZIP_ENTRIES = 5_000;

const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;

const MAX_COMPRESSION_RATIO = 200;

const MAX_INCLUDE_DEPTH = 8;

const MAX_PACKAGE_PATH_LENGTH = 1_024;

const MAX_COLOR_VALUE_LENGTH = 128;

const MAX_RESOLVED_THEME_FILES = MAX_THEMES_PER_EXTENSION * MAX_INCLUDE_DEPTH;

const USED_WORKBENCH_COLORS = new Set([
  "activityBar.background",
  "activityBarBadge.background",
  "badge.background",
  "button.background",
  "button.foreground",
  "contrastBorder",
  "descriptionForeground",
  "disabledForeground",
  "dropdown.background",
  "dropdown.border",
  "editor.background",
  "editor.foreground",
  "editor.selectionBackground",
  "editorCursor.foreground",
  "editorError.foreground",
  "editorGroup.border",
  "editorPane.background",
  "editorWarning.foreground",
  "editorWidget.background",
  "errorForeground",
  "focusBorder",
  "foreground",
  "input.border",
  "input.placeholderForeground",
  "list.activeSelectionBackground",
  "list.hoverBackground",
  "list.inactiveSelectionBackground",
  "menu.background",
  "panel.background",
  "panel.border",
  "progressBar.background",
  "quickInput.background",
  "scrollbarSlider.background",
  "sideBar.background",
  "sideBar.border",
  "sideBar.foreground",
  "terminal.background",
  "terminal.foreground",
  "terminal.selectionBackground",
  "terminalCursor.foreground",
  "textCodeBlock.background",
  "textLink.foreground",
]);

function sanitizeThemeObject(value: Record<string, unknown>): Record<string, unknown> {
  const colors: Record<string, string> = {};

  if (isRecord(value.colors)) {
    for (const [key, color] of Object.entries(value.colors)) {
      if (
        USED_WORKBENCH_COLORS.has(key) &&
        Predicate.isString(color) &&
        color.length <= MAX_COLOR_VALUE_LENGTH
      ) {
        colors[key] = color;
      }
    }
  }

  return {
    ...(Predicate.isString(value.include) ? { include: value.include } : {}),
    colors,
  };
}

export function normalizePackagePath(path: string, relativeTo = "extension/"): string {
  if (
    path.length > MAX_PACKAGE_PATH_LENGTH ||
    path.includes("\0") ||
    path.startsWith("/") ||
    /^[a-zA-Z]:/.test(path)
  ) {
    throw new Error("Theme path is not a safe relative package path.");
  }

  const normalizedInput = path.replaceAll("\\", "/");
  const baseSegments = relativeTo.split("/").slice(0, -1);
  const segments = baseSegments;

  for (const segment of normalizedInput.split("/")) {
    if (!segment || segment === ".") continue;

    if (segment === "..") {
      if (segments.length <= 1) throw new Error("Theme path escapes the extension package.");
      segments.pop();
      continue;
    }

    segments.push(segment);
  }

  if (segments[0] !== "extension") segments.unshift("extension");

  return segments.join("/");
}

export function contributionType(uiTheme: unknown): string | null {
  if (uiTheme === "vs") return "light";

  if (uiTheme === "vs-dark") return "dark";

  if (uiTheme === "hc-black" || uiTheme === "hc-light") return uiTheme;

  return null;
}

type ZipEntrySizes = {
  uncompressedSize?: unknown;
};

type InspectableZipObject = JSZip.JSZipObject & {
  _data?: ZipEntrySizes;
  unsafeOriginalName?: string;
  internalStream?: (type: "uint8array") => JSZip.JSZipStreamHelper<Uint8Array>;
};

export function inspectZipDirectory(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimumOffset = Math.max(0, bytes.byteLength - 65_557);
  let endOffset = bytes.byteLength - 22;

  while (
    endOffset >= minimumOffset &&
    (view.getUint32(endOffset, true) !== 0x06054b50 ||
      endOffset + 22 + view.getUint16(endOffset + 20, true) !== bytes.byteLength)
  ) {
    endOffset -= 1;
  }

  if (endOffset < minimumOffset) throw new Error("That extension package has no ZIP directory.");

  const directorySize = view.getUint32(endOffset + 12, true);
  const directoryOffset = view.getUint32(endOffset + 16, true);
  const directoryEnd = directoryOffset + directorySize;

  if (directoryEnd !== endOffset || directoryEnd > bytes.byteLength) {
    throw new Error("That extension package has an invalid ZIP directory.");
  }

  let entryCount = 0;
  let totalUncompressed = 0;
  let offset = directoryOffset;

  while (offset < directoryEnd) {
    if (offset + 46 > directoryEnd || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("That extension package has an invalid ZIP directory.");
    }

    entryCount += 1;

    if (entryCount > MAX_ZIP_ENTRIES) {
      throw new Error("That extension package has too many files.");
    }

    const compressed = view.getUint32(offset + 20, true);
    const uncompressed = view.getUint32(offset + 24, true);

    if (compressed === 0xffffffff || uncompressed === 0xffffffff) {
      throw new Error("That extension package has unsupported ZIP64 metadata.");
    }

    totalUncompressed += uncompressed;

    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
      throw new Error("That extension package expands beyond the safe import limit.");
    }

    if (
      uncompressed > 0 &&
      (compressed === 0 || uncompressed / compressed > MAX_COMPRESSION_RATIO)
    ) {
      throw new Error("That extension package has an unsafe compression ratio.");
    }

    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    offset += 46 + nameLength + extraLength + commentLength;
  }

  if (offset !== directoryEnd)
    throw new Error("That extension package has an invalid ZIP directory.");

  const commentLength = view.getUint16(endOffset + 20, true);

  if (commentLength === 0) return bytes;

  // JSZip mistakes EOCD-like bytes inside an archive comment for the real EOCD.
  // The comment is not needed for theme import, so remove it before parsing.
  const withoutComment = bytes.slice(0, endOffset + 22);
  withoutComment[endOffset + 20] = 0;
  withoutComment[endOffset + 21] = 0;

  return withoutComment;
}

export function inspectZip(zip: JSZip): void {
  const entries = Object.values(zip.files) as InspectableZipObject[];

  if (entries.length > MAX_ZIP_ENTRIES)
    throw new Error("That extension package has too many files.");

  for (const entry of entries) {
    if (entry.unsafeOriginalName) normalizePackagePath(entry.unsafeOriginalName);
  }
}

export async function readZipText(
  zip: JSZip,
  path: string,
  description: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const file = zip.file(path) as InspectableZipObject | null;

  if (!file) throw new Error(`${description} is missing from the extension package.`);

  if (!Predicate.isNumber(file._data?.uncompressedSize) || !file.internalStream) {
    throw new Error(`${description} has unreadable size metadata.`);
  }

  if (file._data.uncompressedSize > MAX_THEME_BYTES) {
    throw new Error(`${description} is too large.`);
  }

  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    let settled = false;
    const stream = file.internalStream!("uint8array");
    const cleanup = () => signal?.removeEventListener("abort", handleAbort);

    const handleAbort = () => {
      if (settled) return;
      settled = true;
      stream.pause();
      cleanup();
      reject(signal?.reason);
    };

    signal?.addEventListener("abort", handleAbort, { once: true });
    stream
      .on("data", (chunk) => {
        if (settled) return;
        byteLength += chunk.byteLength;

        if (byteLength > MAX_THEME_BYTES) {
          settled = true;
          stream.pause();
          cleanup();
          reject(new Error(`${description} is too large.`));

          return;
        }

        chunks.push(chunk);
      })
      .on("error", (cause) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(cause);
      })
      .on("end", () => {
        if (settled) return;
        settled = true;
        cleanup();
        const bytes = new Uint8Array(byteLength);
        let offset = 0;

        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }

        resolve(new TextDecoder().decode(bytes));
      })
      .resume();
  });
}

export async function loadThemeObject(
  zip: JSZip,
  path: string,
  cache: Map<string, Record<string, unknown>>,
  budget: { files: number },
  ancestors: ReadonlySet<string> = new Set(),
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();

  if (ancestors.size >= MAX_INCLUDE_DEPTH) throw new Error("Theme includes are nested too deeply.");

  if (ancestors.has(path)) throw new Error("Theme includes contain a cycle.");
  const cached = cache.get(path);

  if (cached) return cached;
  budget.files += 1;

  if (budget.files > MAX_RESOLVED_THEME_FILES) {
    throw new Error("That extension references too many theme files.");
  }

  const value = sanitizeThemeObject(
    parseJsoncObject(await readZipText(zip, path, path, signal), path),
  );

  if (!Predicate.isString(value.include)) {
    cache.set(path, value);

    return value;
  }

  const includePath = normalizePackagePath(value.include, path);
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(path);
  const base = await loadThemeObject(zip, includePath, cache, budget, nextAncestors, signal);

  const resolved = {
    ...base,
    ...value,
    colors: {
      ...(isRecord(base.colors) ? base.colors : {}),
      ...(isRecord(value.colors) ? value.colors : {}),
    },
  };

  cache.set(path, resolved);

  return resolved;
}

export async function fetchPackage(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, signal ? { signal } : {});

  if (!response.ok) throw new Error("That Open VSX theme could not be downloaded.");

  return readCappedResponse(
    response,
    MAX_VSIX_BYTES,
    "That theme extension is too large to import safely.",
  );
}
