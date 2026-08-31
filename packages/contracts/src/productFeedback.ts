import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

export const PRODUCT_FEEDBACK_BODY_MAX_BYTES = 16_384;
export const PRODUCT_FEEDBACK_TEXT_MAX_CHARS = 4_000;
export const PRODUCT_FEEDBACK_ELEMENT_LABEL_MAX_CHARS = 120;
export const AKERU_PRODUCT_FEEDBACK_TOOL_NAME = "akeru_product_feedback";

const ShortText = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

/**
 * A privacy-filtered reference to Akeru UI. This deliberately excludes DOM,
 * attributes, styles, values, and files.
 */
export const ProductFeedbackElement = Schema.Struct({
  selector: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  component: Schema.optionalKey(ShortText),
  source: Schema.optionalKey(
    TrimmedNonEmptyString.check(Schema.isMaxLength(128), Schema.isPattern(/^[a-z0-9_.:-]+$/i)),
  ),
  role: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  label: Schema.optionalKey(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PRODUCT_FEEDBACK_ELEMENT_LABEL_MAX_CHARS)),
  ),
});
export type ProductFeedbackElement = typeof ProductFeedbackElement.Type;

/** Editable fields that an agent may propose. No network or host metadata is accepted here. */
export const ProductFeedbackToolDraft = Schema.Struct({
  feedback: TrimmedNonEmptyString.check(Schema.isMaxLength(PRODUCT_FEEDBACK_TEXT_MAX_CHARS)),
});
export type ProductFeedbackToolDraft = typeof ProductFeedbackToolDraft.Type;

export const ProductFeedbackSubmission = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  feedback: TrimmedNonEmptyString.check(Schema.isMaxLength(PRODUCT_FEEDBACK_TEXT_MAX_CHARS)),
  element: Schema.optionalKey(ProductFeedbackElement),
  installToken: TrimmedNonEmptyString.check(
    Schema.isMinLength(22),
    Schema.isMaxLength(128),
    Schema.isPattern(/^[a-z0-9_-]+$/i),
  ),
  turnstileToken: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(2_048))),
  website: TrimmedString.check(Schema.isMaxLength(0)),
});
export type ProductFeedbackSubmission = typeof ProductFeedbackSubmission.Type;

export const StoredProductFeedbackSubmission = Schema.Struct({
  schemaVersion: ProductFeedbackSubmission.fields.schemaVersion,
  feedback: ProductFeedbackSubmission.fields.feedback,
  element: ProductFeedbackSubmission.fields.element,
});
export type StoredProductFeedbackSubmission = typeof StoredProductFeedbackSubmission.Type;

export const ProductFeedbackReceipt = Schema.Struct({
  feedbackId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  receivedAt: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
});
export type ProductFeedbackReceipt = typeof ProductFeedbackReceipt.Type;

export const ProductFeedbackRejectionReason = Schema.Literals([
  "malformed",
  "oversized",
  "duplicate",
  "cooldown",
  "rate_limited",
  "honeypot",
  "challenge_required",
  "challenge_failed",
  "disabled",
  "internal",
]);
export type ProductFeedbackRejectionReason = typeof ProductFeedbackRejectionReason.Type;

export const ProductFeedbackRejection = Schema.Struct({
  reason: ProductFeedbackRejectionReason,
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  retryAfterSeconds: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  challengeSiteKey: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
});
export type ProductFeedbackRejection = typeof ProductFeedbackRejection.Type;
