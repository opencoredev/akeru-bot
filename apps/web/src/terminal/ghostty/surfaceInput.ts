import { isMacPlatform } from "../../lib/utils";

export function isTerminalCopyShortcut(
  event: Pick<KeyboardEvent, "ctrlKey" | "key" | "metaKey" | "shiftKey">,
  platform = navigator.platform,
) {
  if (event.key.toLowerCase() !== "c") return false;

  return isMacPlatform(platform) ? event.metaKey : event.ctrlKey;
}

/**
 * Canvas terminals have no DOM selection. Native copy and Electron's Edit
 * menu `role: "copy"` both read the focused textarea, so an empty IME field
 * writes blankness to the clipboard. Park the Ghostty selection there first.
 */
export function primeTerminalCopyInput(
  input: Pick<HTMLTextAreaElement, "value" | "select">,
  selection: string,
): void {
  input.value = selection;

  if (selection.length === 0) return;
  input.select();
}

export function clearPrimedTerminalCopyInput(
  input: Pick<HTMLTextAreaElement, "value">,
  primedSelection: string,
): void {
  // Only blank the copy we parked. The same textarea holds the IME candidate;
  // wiping whatever is there would cancel CJK composition.
  if (primedSelection.length === 0 || input.value !== primedSelection) return;
  input.value = "";
}

/**
 * Only a copy event that actually received the selection may cancel the
 * clipboard.writeText fallback. Claiming without clipboardData (Electron's
 * menu Copy) used to preventDefault an empty write and skip the fallback,
 * which is how Cmd+C copied blankness.
 */
export function applyTerminalCopyEvent(
  selection: string,
  clipboardData: { setData: (type: string, data: string) => void } | null | undefined,
): { preventDefault: boolean; claimWriteFallback: boolean } {
  if (selection.length === 0 || !clipboardData) {
    return { preventDefault: false, claimWriteFallback: false };
  }

  clipboardData.setData("text/plain", selection);

  return { preventDefault: true, claimWriteFallback: true };
}

export function isTerminalPasteShortcut(
  event: Pick<KeyboardEvent, "ctrlKey" | "key" | "metaKey" | "shiftKey">,
  platform = navigator.platform,
) {
  const key = event.key.toLowerCase();

  if (key === "insert" && !isMacPlatform(platform)) {
    return event.shiftKey && !event.ctrlKey && !event.metaKey;
  }

  if (key !== "v") return false;

  return isMacPlatform(platform) ? event.metaKey : event.ctrlKey && event.shiftKey;
}

export function isTerminalCompositionCommitInput(event: Pick<InputEvent, "inputType">): boolean {
  return (
    event.inputType === "" ||
    event.inputType === "insertCompositionText" ||
    event.inputType === "insertFromComposition"
  );
}

/** IME keydowns must not touch the hidden textarea; it holds the candidate. */
export function isTerminalCompositionKey(
  event: Pick<KeyboardEvent, "isComposing" | "key" | "keyCode">,
  composing: boolean,
): boolean {
  return event.isComposing || composing || event.key === "Process" || event.keyCode === 229;
}

export function isTerminalAltGraphText(
  event: Pick<KeyboardEvent, "getModifierState" | "key">,
): boolean {
  return event.getModifierState("AltGraph") && [...event.key].length === 1;
}

export function shouldReportTerminalMouse(
  tracking: boolean,
  event: Pick<MouseEvent, "ctrlKey" | "metaKey" | "shiftKey">,
): boolean {
  return tracking && !event.shiftKey && !event.ctrlKey && !event.metaKey;
}

export type TerminalMouseAction = "press" | "release" | "motion";

export function resolveTerminalMouseData(
  action: TerminalMouseAction,
  data: string,
  previousMotionData: string,
): { readonly send: boolean; readonly nextMotionData: string } {
  const nextMotionData = action === "motion" ? data : "";

  return {
    send: data.length > 0 && (action !== "motion" || data !== previousMotionData),
    nextMotionData,
  };
}

export function resolveTerminalMouseTrackingState(
  previousTracking: boolean,
  tracking: boolean,
  motionData: string,
): { readonly tracking: boolean; readonly motionData: string } {
  return {
    tracking,
    motionData: previousTracking === tracking ? motionData : "",
  };
}

export function terminalWheelDeltaRows(
  event: Pick<WheelEvent, "deltaY" | "deltaMode">,
  cellHeight: number,
  viewportRows: number,
  remainder: number,
): { readonly rows: number; readonly remainder: number } {
  // deltaMode: 0 pixels, 1 lines, 2 pages.
  const pixels =
    event.deltaMode === 1
      ? event.deltaY * cellHeight
      : event.deltaMode === 2
        ? event.deltaY * viewportRows * cellHeight
        : event.deltaY;

  const total = remainder + pixels / cellHeight;
  const rows = Math.trunc(total);

  return { rows, remainder: total - rows };
}

export function terminalWheelArrowData(rows: number, applicationCursorKeys: boolean): string {
  if (rows === 0) return "";

  const sequence =
    rows < 0
      ? applicationCursorKeys
        ? "\u001bOA"
        : "\u001b[A"
      : applicationCursorKeys
        ? "\u001bOB"
        : "\u001b[B";

  return sequence.repeat(Math.abs(rows));
}

export function isTerminalLinkPointerGesture(
  event: Pick<MouseEvent, "ctrlKey" | "metaKey">,
  platform = navigator.platform,
): boolean {
  return isMacPlatform(platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

export function ghosttyMouseButton(button: number): number | null {
  switch (button) {
    case 0:
      return 1;
    case 1:
      return 3;
    case 2:
      return 2;
    case 3:
      return 4;
    case 4:
      return 5;
    default:
      return null;
  }
}

export interface TerminalSelectionClickSequence {
  readonly count: number;
  readonly time: number;
  readonly x: number;
  readonly y: number;
}

export function advanceTerminalSelectionClickSequence(
  previous: TerminalSelectionClickSequence | null,
  event: Pick<PointerEvent, "clientX" | "clientY" | "timeStamp">,
): TerminalSelectionClickSequence {
  const repeats =
    previous !== null &&
    event.timeStamp - previous.time <= 500 &&
    Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <= 4;

  return {
    count: repeats ? (previous.count >= 3 ? 1 : previous.count + 1) : 1,
    time: event.timeStamp,
    x: event.clientX,
    y: event.clientY,
  };
}
