import {
  PRODUCT_FEEDBACK_TEXT_MAX_CHARS,
  ProductFeedbackToolDraft,
  type ProductFeedbackElement,
} from "@akeru/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { create } from "zustand";

/** Decodes untrusted tool arguments; None when they carry anything besides the bounded draft fields. */
export const decodeProductFeedbackToolArgs = Schema.decodeUnknownOption(ProductFeedbackToolDraft, {
  onExcessProperty: "error",
});

export interface ProductFeedbackDraft {
  readonly feedback: string;
  readonly element: ProductFeedbackElement | null;
}

export const EMPTY_PRODUCT_FEEDBACK_DRAFT: ProductFeedbackDraft = {
  feedback: "",
  element: null,
};

interface ProductFeedbackDialogState {
  readonly open: boolean;
  readonly picking: boolean;
  readonly draft: ProductFeedbackDraft;
  readonly openFeedback: (draft?: Partial<ProductFeedbackDraft>) => void;
  readonly closeFeedback: () => void;
  readonly startPicking: () => void;
  readonly stopPicking: (element?: ProductFeedbackElement) => void;
  readonly updateDraft: (draft: Partial<ProductFeedbackDraft>) => void;
  readonly clearDraft: () => void;
  readonly completeFeedback: () => void;
}

export const useProductFeedbackStore = create<ProductFeedbackDialogState>((set) => ({
  open: false,
  picking: false,
  draft: EMPTY_PRODUCT_FEEDBACK_DRAFT,
  openFeedback: (draft) =>
    set((state) => ({
      open: true,
      picking: false,
      draft: { ...state.draft, ...draft },
    })),
  closeFeedback: () => set({ open: false, picking: false }),
  startPicking: () => set({ open: false, picking: true }),
  stopPicking: (element) =>
    set((state) => ({
      open: true,
      picking: false,
      draft: element ? { ...state.draft, element } : state.draft,
    })),
  updateDraft: (draft) => set((state) => ({ draft: { ...state.draft, ...draft } })),
  clearDraft: () => set({ draft: EMPTY_PRODUCT_FEEDBACK_DRAFT }),
  completeFeedback: () => set({ open: false, picking: false, draft: EMPTY_PRODUCT_FEEDBACK_DRAFT }),
}));

export function openProductFeedback(draft?: Partial<ProductFeedbackDraft>): void {
  useProductFeedbackStore.getState().openFeedback(draft);
}

export function openProductFeedbackWithPrefill(feedback: string): void {
  const current = useProductFeedbackStore.getState().draft;
  useProductFeedbackStore.getState().openFeedback({
    feedback: appendBounded(current.feedback, feedback, PRODUCT_FEEDBACK_TEXT_MAX_CHARS),
  });
}

export function productFeedbackDraftFromToolArgs(
  decoded: Option.Option<ProductFeedbackToolDraft>,
): Partial<ProductFeedbackDraft> | null {
  if (Option.isNone(decoded)) return null;

  return { feedback: decoded.value.feedback };
}

function appendBounded(current: string, proposed: string, maxLength: number): string {
  const left = current.trim();
  const right = proposed.trim();

  if (!left) return right.slice(0, maxLength);

  if (!right || left === right) return left.slice(0, maxLength);

  return `${left}\n\n${right}`.slice(0, maxLength);
}

export function openProductFeedbackFromToolArgs(
  decoded: Option.Option<ProductFeedbackToolDraft>,
): boolean {
  const proposed = productFeedbackDraftFromToolArgs(decoded);

  if (!proposed?.feedback) return false;
  openProductFeedbackWithPrefill(proposed.feedback);

  return true;
}
