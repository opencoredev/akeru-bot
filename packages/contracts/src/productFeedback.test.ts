import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { ProductFeedbackSubmission, ProductFeedbackToolDraft } from "./productFeedback.ts";

const decodeExitProductFeedbackSubmission = Schema.decodeUnknownExit(ProductFeedbackSubmission);

const decodeExitProductFeedbackSubmissionStrict = Schema.decodeUnknownExit(
  ProductFeedbackSubmission,
  {
    onExcessProperty: "error",
  },
);

const decodeExitProductFeedbackToolDraftStrict = Schema.decodeUnknownExit(
  ProductFeedbackToolDraft,
  {
    onExcessProperty: "error",
  },
);

const submission = {
  schemaVersion: 1,
  feedback: "The button does not respond.",
  installToken: "install_token_1234567890",
  website: "",
} as const;

describe("ProductFeedbackSubmission", () => {
  it("accepts the bounded anonymous payload", () => {
    expect(Exit.isSuccess(decodeExitProductFeedbackSubmission(submission))).toBe(true);
  });

  it("rejects conversation data and oversized feedback", () => {
    expect(
      Exit.isFailure(
        decodeExitProductFeedbackSubmissionStrict({
          ...submission,
          conversation: "private thread",
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        decodeExitProductFeedbackSubmission({
          ...submission,
          feedback: "x".repeat(4_001),
        }),
      ),
    ).toBe(true);
  });
});

describe("ProductFeedbackToolDraft", () => {
  it("accepts feedback text and rejects every other field", () => {
    const decode = decodeExitProductFeedbackToolDraftStrict;

    expect(Exit.isSuccess(decode({ feedback: "Add a shortcut." }))).toBe(true);
    expect(
      Exit.isFailure(
        decode({
          feedback: "Add a shortcut.",
          installToken: "not-agent-controlled",
        }),
      ),
    ).toBe(true);
  });
});
