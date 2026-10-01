import { flow } from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "@akeru/contracts";
import * as Predicate from "effect/Predicate";
import type { ToolLifecycleItemType } from "@akeru/contracts";

const RuntimeRecord = Schema.declare(
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Tool data is an opaque provider object; each presentation field is decoded separately.
  (value: unknown): value is Record<string, unknown> => Predicate.isObject(value),
);

type RuntimeRecord = typeof RuntimeRecord.Type;

const decodeRuntimeRecord = Schema.decodeUnknownOption(RuntimeRecord);

const decodeTrimmedString = Schema.decodeUnknownOption(TrimmedNonEmptyString);

const asRecord = flow(decodeRuntimeRecord, Option.getOrUndefined);

const asTrimmedString = flow(decodeTrimmedString, Option.getOrUndefined);

const CommandValue = Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]);

type CommandValue = typeof CommandValue.Type;

const decodeCommandValue = Schema.decodeUnknownOption(CommandValue);

function formatDecodedCommandValue(value: CommandValue): string | undefined {
  const direct = asTrimmedString(value);

  if (direct) {
    return direct;
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const parts: string[] = [];

  for (const entry of value) {
    const part = asTrimmedString(entry);

    if (part !== undefined) {
      parts.push(part);
    }
  }

  return parts.length > 0 ? parts.join(" ") : undefined;
}

const normalizeCommandValue = flow(
  decodeCommandValue,
  Option.map(formatDecodedCommandValue),
  Option.getOrUndefined,
);

function stripTrailingExitCode(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  if (!trimmed) {
    return undefined;
  }

  const match = /^(?<output>[\s\S]*?)(?:\s*<exited with exit code \d+>)\s*$/iu.exec(trimmed);
  const output = match?.groups?.output?.trim() ?? trimmed;

  return output.length > 0 ? output : undefined;
}

function extractCommandFromTitle(title: string | undefined): string | undefined {
  if (!title) {
    return undefined;
  }

  const backtickMatch = /`([^`]+)`/u.exec(title);

  return backtickMatch?.[1]?.trim() || undefined;
}

function extractToolCommand(data: RuntimeRecord | undefined, title: string | undefined) {
  const item = asRecord(data?.item);
  const itemInput = asRecord(item?.input);
  const itemResult = asRecord(item?.result);
  const rawInput = asRecord(data?.rawInput);

  const candidates = [
    normalizeCommandValue(item?.command),
    normalizeCommandValue(itemInput?.command),
    normalizeCommandValue(itemResult?.command),
    normalizeCommandValue(data?.command),
    normalizeCommandValue(rawInput?.command),
  ];

  const direct = candidates.find((candidate) => candidate !== undefined);

  if (direct) {
    return direct;
  }

  const executable = asTrimmedString(rawInput?.executable);
  const args = normalizeCommandValue(rawInput?.args);

  if (executable && args) {
    return `${executable} ${args}`;
  }

  if (executable) {
    return executable;
  }

  return extractCommandFromTitle(title);
}

function maybePathLike(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  if (
    value.includes("/") ||
    value.includes("\\") ||
    value.startsWith(".") ||
    /\.(?:[a-z0-9]{1,12})$/iu.test(value)
  ) {
    return value;
  }

  return undefined;
}

function collectPaths(
  value: Parameters<typeof asRecord>[0],
  paths: string[],
  seen: Set<string>,
  depth: number,
): void {
  if (depth > 4 || paths.length >= 8) {
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectPaths(entry, paths, seen, depth + 1);

      if (paths.length >= 8) {
        return;
      }
    }

    return;
  }

  const record = asRecord(value);

  if (!record) {
    return;
  }

  for (const key of ["path", "filePath", "relativePath", "filename", "newPath", "oldPath"]) {
    const candidate = maybePathLike(asTrimmedString(record[key]));

    if (!candidate || seen.has(candidate)) {
      continue;
    }

    seen.add(candidate);
    paths.push(candidate);

    if (paths.length >= 8) {
      return;
    }
  }

  for (const nestedKey of ["locations", "item", "input", "result", "rawInput", "data", "changes"]) {
    if (!(nestedKey in record)) {
      continue;
    }

    collectPaths(record[nestedKey], paths, seen, depth + 1);

    if (paths.length >= 8) {
      return;
    }
  }
}

function extractPrimaryPath(data: RuntimeRecord | undefined): string | undefined {
  const paths: string[] = [];
  collectPaths(data, paths, new Set<string>(), 0);

  return paths[0];
}

function normalizeEquivalentValue(value: string | undefined): string | undefined {
  const trimmed = asTrimmedString(value);

  if (!trimmed) {
    return undefined;
  }

  return trimmed
    .replace(/\s+/gu, " ")
    .replace(/\s+(?:complete|completed|started)\s*$/iu, "")
    .trim();
}

function isEquivalent(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizeEquivalentValue(left)?.toLowerCase();
  const normalizedRight = normalizeEquivalentValue(right)?.toLowerCase();

  return normalizedLeft !== undefined && normalizedLeft === normalizedRight;
}

function classifyToolAction(input: {
  readonly itemType?: ToolLifecycleItemType | null | undefined;
  readonly title?: string | undefined;
  readonly data?: RuntimeRecord | undefined;
}): "command" | "read" | "file_change" | "search" | "other" {
  const itemType = input.itemType ?? undefined;
  const kind = asTrimmedString(input.data?.kind)?.toLowerCase();
  const title = asTrimmedString(input.title)?.toLowerCase();

  if (itemType === "command_execution" || kind === "execute" || title === "terminal") {
    return "command";
  }

  if (kind === "read" || title === "read file") {
    return "read";
  }

  if (
    itemType === "file_change" ||
    kind === "edit" ||
    kind === "move" ||
    kind === "delete" ||
    kind === "write"
  ) {
    return "file_change";
  }

  if (itemType === "web_search" || kind === "search" || title === "find" || title === "grep") {
    return "search";
  }

  return "other";
}

export interface ToolActivityPresentationInput {
  readonly itemType?: ToolLifecycleItemType | null | undefined;
  readonly title?: string | null | undefined;
  readonly detail?: string | null | undefined;
  readonly data?: unknown;
  readonly fallbackSummary?: string | null | undefined;
}

export interface ToolActivityPresentation {
  readonly summary: string;
  readonly detail?: string | undefined;
}

export function deriveToolActivityPresentation(
  input: ToolActivityPresentationInput,
): ToolActivityPresentation {
  const title = asTrimmedString(input.title);
  const detail = stripTrailingExitCode(asTrimmedString(input.detail));
  const fallbackSummary = asTrimmedString(input.fallbackSummary) ?? "Tool";
  const data = asRecord(input.data);
  const command = extractToolCommand(data, title);
  const primaryPath = extractPrimaryPath(data);

  const action = classifyToolAction({
    itemType: input.itemType,
    title,
    data,
  });

  if (action === "command") {
    return {
      summary: "Ran command",
      ...(command ? { detail: command } : {}),
    };
  }

  if (action === "read") {
    if (primaryPath) {
      return {
        summary: "Read file",
        detail: primaryPath,
      };
    }

    return {
      summary: "Read file",
    };
  }

  if (action === "file_change") {
    return {
      summary: "Changed files",
      ...(primaryPath ? { detail: primaryPath } : {}),
    };
  }

  if (action === "search") {
    const query =
      asTrimmedString(asRecord(data?.rawInput)?.query) ??
      asTrimmedString(asRecord(data?.rawInput)?.pattern) ??
      asTrimmedString(asRecord(data?.rawInput)?.searchTerm);

    return {
      summary: "Searched files",
      ...(query ? { detail: query } : {}),
    };
  }

  if (detail && !isEquivalent(detail, title) && !isEquivalent(detail, fallbackSummary)) {
    return {
      summary: title ?? fallbackSummary,
      detail,
    };
  }

  return {
    summary: title ?? fallbackSummary,
  };
}
