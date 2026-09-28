// A stack frame: "at fn (file:///...)", "at Class.method (definition) (node:...)",
// or a bare "at file:///...". Only frames that name a location count, so a
// sentence such as "Could not look at the file" is left alone.
const STACK_FRAME = /\s+at\s+(?:\S+\s+)*?\(?(?:file|node|https?):\/*\S/;
const ERROR_CLASS_PREFIX = /^(?:[A-Z][A-Za-z0-9]*)?Error:\s+/;

/**
 * The first readable line of an error message, for failure text a user sees.
 * Drops everything from the first stack frame on, the rest of a multi-line
 * message, and a leading error class name such as `ProviderValidationError:`.
 * Stored rows written before failures were stored readable still carry the
 * full stack, so clients pass stored failure text through this too.
 */
export function withoutErrorStack(message: string): string {
  const firstLine =
    message
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  const frame = STACK_FRAME.exec(firstLine);
  const withoutFrames = (frame ? firstLine.slice(0, frame.index) : firstLine).trim();
  return withoutFrames.replace(ERROR_CLASS_PREFIX, "");
}
