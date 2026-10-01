/** Validates guest picker messages before forwarding them to the renderer. */
import {
  PickedElementPayloadSchema,
  PreviewAnnotationPayloadSchema,
  type PickedElementPayload,
  type PreviewAnnotationPayload,
  type PreviewAnnotationRect,
} from "@akeru/contracts";
import * as Schema from "effect/Schema";

const isPickedPayload = Schema.is(PickedElementPayloadSchema);

const isAnnotationPayload = Schema.is(PreviewAnnotationPayloadSchema);

const hasFiniteStack = (payload: PickedElementPayload): boolean =>
  [payload.source, ...payload.stack].every(
    (frame) =>
      frame === null ||
      ((frame.lineNumber === null || Number.isFinite(frame.lineNumber)) &&
        (frame.columnNumber === null || Number.isFinite(frame.columnNumber))),
  );

const hasFiniteRect = (rect: PreviewAnnotationRect): boolean =>
  [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite);

export function isPickedElementPayload(value: unknown): value is PickedElementPayload {
  return isPickedPayload(value) && hasFiniteStack(value);
}

export function isPreviewAnnotationPayload(value: unknown): value is PreviewAnnotationPayload {
  return (
    isAnnotationPayload(value) &&
    value.screenshot === null &&
    value.elements.every(
      (target) => hasFiniteStack(target.element) && hasFiniteRect(target.rect),
    ) &&
    value.regions.every((target) => hasFiniteRect(target.rect)) &&
    value.strokes.every(
      (stroke) =>
        Number.isFinite(stroke.width) &&
        hasFiniteRect(stroke.bounds) &&
        stroke.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)),
    )
  );
}
