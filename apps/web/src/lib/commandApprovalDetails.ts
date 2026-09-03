/**
 * Facts about a pending command approval that the collapsed row cannot show.
 * The approval panel opens its details section only when one of these is present,
 * so a bare command such as "pwd" never offers an expander that repeats itself.
 */
export interface CommandApprovalDetails {
  readonly command: string;
  readonly workingDirectory: string | null;
  readonly reason: string | null;
  readonly programs: ReadonlyArray<string>;
  readonly signals: ReadonlyArray<string>;
  /** True when the collapsed row already shows every character, so expanding must not repeat it. */
  readonly fitsCollapsedRow: boolean;
  readonly hasDetails: boolean;
}

/** Longer than this and the collapsed row truncates, so the full text is worth expanding. */
const TRUNCATING_COMMAND_LENGTH = 64;
const SEGMENT_SEPARATOR = /\s*(?:&&|\|\||[;|\n])\s*/;
const ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const COMMAND_PREFIXES = new Set(["sudo", "command", "exec", "nohup", "time", "env", "xargs"]);

function readString(args: Record<string, unknown>, keys: ReadonlyArray<string>): string | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

/** First real program in a segment, past any env assignments and wrappers like "sudo". */
function programOfSegment(segment: string): string | null {
  for (const token of segment.split(/\s+/)) {
    const bare = token.replace(/^['"]|['"]$/g, "");
    if (bare.length === 0) continue;
    if (ENVIRONMENT_ASSIGNMENT.test(bare)) continue;
    if (bare.startsWith("-")) continue;
    if (COMMAND_PREFIXES.has(bare)) continue;
    return bare.split("/").at(-1) ?? bare;
  }
  return null;
}

function programsOf(command: string): ReadonlyArray<string> {
  const seen: string[] = [];
  for (const segment of command.split(SEGMENT_SEPARATOR)) {
    const program = programOfSegment(segment.trim());
    if (program && !seen.includes(program)) seen.push(program);
  }
  return seen;
}

/** Short labels for the operations a reviewer needs to see before approving. */
function signalsOf(command: string): ReadonlyArray<string> {
  const signals: string[] = [];
  const add = (label: string) => {
    if (!signals.includes(label)) signals.push(label);
  };

  if (/(^|\s)sudo(\s|$)/.test(command)) add("Runs as root");
  if (/(^|\s)rm\s+(-\S*\s+)*-?\S*[rf]/.test(command)) add("Deletes files");
  if (/(^|\s)(curl|wget|ssh|scp|nc|rsync)(\s|$)/.test(command)) add("Network access");
  if (/(^|\s)(git\s+push|npm\s+publish|bun\s+publish|pnpm\s+publish)(\s|$)/.test(command)) {
    add("Publishes");
  }
  if (/>>?\s*\S/.test(command) || /(^|\s|\|)\s*tee(\s|$)/.test(command)) add("Writes files");
  if (/(^|\s)(chmod|chown)(\s|$)/.test(command)) add("Changes permissions");

  return signals;
}

export function describeCommandApproval(command: string, args: unknown): CommandApprovalDetails {
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const workingDirectory = readString(record, [
    "cwd",
    "workdir",
    "working_directory",
    "workingDirectory",
  ]);
  const reason = readString(record, ["justification", "reason", "explanation", "purpose"]);
  const programs = programsOf(command);
  const signals = signalsOf(command);
  const fitsCollapsedRow = !command.includes("\n") && command.length <= TRUNCATING_COMMAND_LENGTH;
  const hasDetails =
    !fitsCollapsedRow ||
    workingDirectory !== null ||
    reason !== null ||
    programs.length > 1 ||
    signals.length > 0;

  return { command, workingDirectory, reason, programs, signals, fitsCollapsedRow, hasDetails };
}
