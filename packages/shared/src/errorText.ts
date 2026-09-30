// A stack frame: "at fn (file:///...)", "at Class.method (definition) (node:...)",
// "at fn (/srv/app.js:1:2)", a bare "at file:///...", or a bare path such as
// "at /srv/app.js:1:2" or "at C:\app\main.js:1:2". Only frames that name a
// location count, so a sentence such as "Could not look at the file" or
// "Try again at 10:30:00" is left alone.
const STACK_FRAME =
  /\s+at\s+(?:(?:async\s+)?[^()\s]*[\\/.][^()\s]*:\d+:\d+(?=\s+at\s|$)|(?:\S+\s+)*?(?:\(?(?:file|node|https?):\/*\S|\([^()\s]+:\d+:\d+\)))/;
const STACK_FRAME_LINE = new RegExp(`^${STACK_FRAME.source}`);
const ANY_FRAME_LINE = /^\s+at\s/;
const ERROR_CLASS_PREFIX = /^(?:[A-Z][A-Za-z0-9]*)?Error:\s+/;

/**
 * An error message without its stack, for failure text a user sees. Drops
 * every stack frame line, a frame collapsed onto the end of a line and all
 * text after it, and a leading error class name such as
 * `ProviderValidationError:`. Other lines of a multi-line message stay.
 * Stored rows written before failures were stored readable still carry the
 * full stack, so clients pass stored failure text through this too.
 */
export function withoutErrorStack(message: string): string {
  const kept: string[] = [];
  let inStack = false;
  for (const line of message.split("\n")) {
    // Frames without a location, such as "at async Promise.all (index 0)",
    // count once a located frame has started the stack.
    if (STACK_FRAME_LINE.test(line) || (inStack && ANY_FRAME_LINE.test(line))) {
      inStack = true;
      continue;
    }
    inStack = false;
    const frame = STACK_FRAME.exec(line);
    kept.push((frame ? line.slice(0, frame.index) : line).trimEnd());
    // Everything after a frame collapsed onto a line is more stack.
    if (frame) break;
  }
  return kept.join("\n").trim().replace(ERROR_CLASS_PREFIX, "");
}
