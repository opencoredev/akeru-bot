import {
  asRecord,
  asTrimmedString,
  extractToolCommand,
  stripTrailingExitCode,
  extractWorkLogItemType,
} from "@akeru/client-runtime/work-log-command";

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function extractToolTitle(payload: Record<string, unknown> | null): string | null {
  return asTrimmedString(payload?.title);
}

export function extractToolCallId(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);

  return asTrimmedString(payload?.toolCallId) ?? asTrimmedString(data?.toolCallId);
}

function normalizeInlinePreview(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateInlinePreview(value: string, maxLength = 84): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function normalizePreviewForComparison(value: string | null | undefined): string | null {
  const normalized = asTrimmedString(value);

  if (!normalized) {
    return null;
  }

  return normalizeCompactToolLabel(normalizeInlinePreview(normalized)).toLowerCase();
}

function summarizeToolTextOutput(value: string): string | null {
  const lines: Array<string> = [];

  for (const rawLine of value.split(/\r?\n/u)) {
    const line = normalizeInlinePreview(rawLine);

    if (line.length > 0) {
      lines.push(line);
    }
  }

  const firstLine = lines.find((line) => line !== "```");

  if (firstLine) {
    return truncateInlinePreview(firstLine);
  }

  if (lines.length > 1) {
    return `${lines.length.toLocaleString()} lines`;
  }

  return null;
}

function summarizeToolRawOutput(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const rawOutput = asRecord(data?.rawOutput);

  if (!rawOutput) {
    return null;
  }

  const totalFiles = asNumber(rawOutput.totalFiles);

  if (totalFiles !== null) {
    const suffix = rawOutput.truncated === true ? "+" : "";

    return `${totalFiles.toLocaleString()} file${totalFiles === 1 ? "" : "s"}${suffix}`;
  }

  const content = asTrimmedString(rawOutput.content);

  if (content) {
    return summarizeToolTextOutput(content);
  }

  const stdout = asTrimmedString(rawOutput.stdout);

  if (stdout) {
    return summarizeToolTextOutput(stdout);
  }

  return null;
}

function extractAcpTextContent(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const chunks: string[] = [];

  for (const entryValue of value) {
    const entry = asRecord(entryValue);

    if (entry?.type !== "content") {
      continue;
    }

    const content = asRecord(entry.content);

    if (content?.type !== "text") {
      continue;
    }

    const text = asTrimmedString(content.text);

    if (text) {
      chunks.push(text);
    }
  }

  return chunks.length > 0 ? chunks.join("\n") : null;
}

function extractToolOutput(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const rawOutput = asRecord(data?.rawOutput);

  const outputStreams: string[] = [];
  const stdout = asTrimmedString(rawOutput?.stdout);
  const stderr = asTrimmedString(rawOutput?.stderr);

  if (stdout) {
    outputStreams.push(stdout);
  }

  if (stderr) {
    outputStreams.push(stderr);
  }

  const candidates: unknown[] = [
    item?.aggregatedOutput,
    itemResult?.content,
    data?.rawOutput,
    rawOutput?.content,
    outputStreams.length > 0 ? outputStreams.join("\n") : null,
    rawOutput?.output,
    extractAcpTextContent(data?.content),
  ];

  for (const candidate of candidates) {
    const text = asTrimmedString(candidate);

    if (!text) {
      continue;
    }

    const output = stripTrailingExitCode(text).output;

    if (output) {
      return output;
    }
  }

  return null;
}

function isCommandToolDetail(payload: Record<string, unknown> | null, heading: string): boolean {
  const data = asRecord(payload?.data);
  const kind = asTrimmedString(data?.kind)?.toLowerCase();
  const title = asTrimmedString(payload?.title ?? heading)?.toLowerCase();

  return (
    extractWorkLogItemType(payload) === "command_execution" ||
    kind === "execute" ||
    title === "terminal" ||
    title === "ran command"
  );
}

export function extractToolDetail(
  payload: Record<string, unknown> | null,
  heading: string,
): string | null {
  const rawDetail = asTrimmedString(payload?.detail);
  const detail = rawDetail ? stripTrailingExitCode(rawDetail).output : null;
  const normalizedHeading = normalizePreviewForComparison(heading);
  const normalizedDetail = normalizePreviewForComparison(detail);
  const commandTool = isCommandToolDetail(payload, heading);

  const commandPreview = commandTool
    ? extractToolCommand(payload)
    : { command: null, rawCommand: null };

  const command = commandPreview.command;
  const normalizedCommand = normalizePreviewForComparison(command);
  const normalizedRawCommand = normalizePreviewForComparison(commandPreview.rawCommand);

  if (
    detail &&
    normalizedHeading !== normalizedDetail &&
    (!commandTool ||
      (normalizedCommand !== normalizedDetail && normalizedRawCommand !== normalizedDetail))
  ) {
    return detail;
  }

  if (commandTool) {
    if (!command) {
      return null;
    }

    const output = extractToolOutput(payload);
    const normalizedOutput = normalizePreviewForComparison(output);

    if (
      output &&
      normalizedOutput !== normalizedHeading &&
      normalizedOutput !== normalizedCommand
    ) {
      return output;
    }

    return null;
  }

  const rawOutputSummary = summarizeToolRawOutput(payload);

  if (rawOutputSummary) {
    const normalizedRawOutputSummary = normalizePreviewForComparison(rawOutputSummary);

    if (normalizedRawOutputSummary !== normalizedHeading) {
      return rawOutputSummary;
    }
  }

  return null;
}
