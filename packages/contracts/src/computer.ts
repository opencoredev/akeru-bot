import { Schema } from "effect";
import { NonNegativeInt, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Ephemeral workspace computer transport. Never persist frames, input, or session tokens. */
export const COMPUTER_FRAME_MAX_BYTES = 256 * 1024;
export const COMPUTER_SESSION_TTL_MS = 60_000;
const Token = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const Coordinate = NonNegativeInt.check(Schema.isLessThanOrEqualTo(8192));
export const ComputerTarget = Schema.Struct({ threadId: ThreadId });
export type ComputerTarget = typeof ComputerTarget.Type;
export const ComputerSessionInput = Schema.Struct({ threadId: ThreadId, sessionId: Token });
export type ComputerSessionInput = typeof ComputerSessionInput.Type;
export const ComputerAction = Schema.Union([
  Schema.TaggedStruct("click", {
    x: Coordinate,
    y: Coordinate,
    button: Schema.Literals(["left", "right", "middle"]),
  }),
  Schema.TaggedStruct("move", { x: Coordinate, y: Coordinate }),
  Schema.TaggedStruct("scroll", {
    direction: Schema.Literals(["up", "down"]),
    amount: PositiveInt.check(Schema.isLessThanOrEqualTo(2000)),
  }),
  Schema.TaggedStruct("key", { key: TrimmedNonEmptyString.check(Schema.isMaxLength(128)) }),
  Schema.TaggedStruct("type", { text: Schema.String.check(Schema.isMaxLength(4096)) }),
]);
export type ComputerAction = typeof ComputerAction.Type;
export const ComputerInput = Schema.Struct({
  ...ComputerSessionInput.fields,
  sequence: PositiveInt,
  action: ComputerAction,
});
export type ComputerInput = typeof ComputerInput.Type;
export const ComputerState = Schema.Struct({
  threadId: ThreadId,
  status: Schema.Literals(["unavailable", "closed", "ready", "human", "stopped"]),
  capability: Schema.Literals(["none", "browser", "desktop"]),
  controlAvailable: Schema.Boolean,
  reason: Schema.NullOr(Schema.String),
  workspaceId: Schema.NullOr(Schema.String),
});
export type ComputerState = typeof ComputerState.Type;
export const ComputerSession = Schema.Struct({
  sessionId: Token,
  expiresAt: NonNegativeInt,
  state: ComputerState,
});
export type ComputerSession = typeof ComputerSession.Type;
export const ComputerFrame = Schema.Struct({
  mimeType: Schema.Literals(["image/png", "image/jpeg"]),
  data: Schema.String.check(Schema.isMaxLength(Math.ceil(COMPUTER_FRAME_MAX_BYTES / 3) * 4)),
  width: PositiveInt.check(Schema.isLessThanOrEqualTo(8192)),
  height: PositiveInt.check(Schema.isLessThanOrEqualTo(8192)),
});
export type ComputerFrame = typeof ComputerFrame.Type;
/** Ordered metadata only for LEO-292. No text, keys, selectors, coordinates, tokens, or rich text capture. */
export const ComputerActionReceipt = Schema.Struct({
  workspaceId: Schema.String,
  ordinal: PositiveInt,
  category: Schema.Literals(["click", "move", "scroll", "key", "type"]),
});
export type ComputerActionReceipt = typeof ComputerActionReceipt.Type;

/** Observation is subscription-only; acquiring control drains bot input before returning. */
export const ComputerEvent = Schema.Union([
  Schema.TaggedStruct("state", { state: ComputerState }),
  Schema.TaggedStruct("frame", { frame: ComputerFrame }),
  Schema.TaggedStruct("action", { receipt: ComputerActionReceipt }),
]);
export type ComputerEvent = typeof ComputerEvent.Type;
export class ComputerError extends Schema.TaggedErrorClass<ComputerError>()("ComputerError", {
  code: Schema.Literals(["unsupported", "closed", "busy", "revoked", "sequence", "adapter"]),
  message: Schema.String,
}) {}
