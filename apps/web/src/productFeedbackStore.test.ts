import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  EMPTY_PRODUCT_FEEDBACK_DRAFT,
  openProductFeedback,
  openProductFeedbackFromToolArgs,
  openProductFeedbackWithPrefill,
  productFeedbackDraftFromToolArgs,
  useProductFeedbackStore,
} from "./productFeedbackStore";

beforeEach(() => {
  useProductFeedbackStore.setState({
    open: false,
    picking: false,
    draft: EMPTY_PRODUCT_FEEDBACK_DRAFT,
  });
});

describe("product feedback store", () => {
  it("uses one draft for Help, Settings, picking, and retry", () => {
    openProductFeedback({ feedback: "Draft from Help" });
    useProductFeedbackStore.getState().startPicking();
    useProductFeedbackStore.getState().stopPicking();
    useProductFeedbackStore.getState().closeFeedback();
    openProductFeedback();

    expect(useProductFeedbackStore.getState().draft.feedback).toBe("Draft from Help");
  });

  it("removes an attached element and clears only on explicit success", () => {
    openProductFeedback({
      feedback: "Button issue",
      element: { selector: 'button[data-feedback-target="send"]', label: "Send" },
    });
    useProductFeedbackStore.getState().updateDraft({ element: null });
    expect(useProductFeedbackStore.getState().draft.element).toBeNull();
    expect(useProductFeedbackStore.getState().draft.feedback).toBe("Button issue");

    useProductFeedbackStore.getState().clearDraft();
    expect(useProductFeedbackStore.getState().draft).toEqual(EMPTY_PRODUCT_FEEDBACK_DRAFT);
  });

  it("closes and clears the dialog after a successful submission", () => {
    openProductFeedback({ feedback: "The action failed." });

    useProductFeedbackStore.getState().completeFeedback();

    expect(useProductFeedbackStore.getState()).toMatchObject({
      open: false,
      picking: false,
      draft: EMPTY_PRODUCT_FEEDBACK_DRAFT,
    });
  });

  it("decodes only bounded bot-authored draft fields", () => {
    expect(
      productFeedbackDraftFromToolArgs({
        feedback: "The label is unclear.",
      }),
    ).toEqual({ feedback: "The label is unclear." });
    expect(
      productFeedbackDraftFromToolArgs({
        feedback: "Private payload",
        conversation: "full thread",
      }),
    ).toBeNull();
  });

  it("adds an agent proposal without replacing a manual draft", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    openProductFeedback({
      feedback: "My existing report.",
    });

    expect(
      openProductFeedbackFromToolArgs({
        feedback: "Agent proposal.",
      }),
    ).toBe(true);
    expect(useProductFeedbackStore.getState().draft).toMatchObject({
      feedback: "My existing report.\n\nAgent proposal.",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("adds error context without replacing an existing manual draft", () => {
    openProductFeedback({ feedback: "My existing report." });
    useProductFeedbackStore.getState().closeFeedback();

    openProductFeedbackWithPrefill("A request failed.");

    expect(useProductFeedbackStore.getState()).toMatchObject({
      open: true,
      draft: { feedback: "My existing report.\n\nA request failed." },
    });
  });
});
