import {
  PRODUCT_FEEDBACK_TEXT_MAX_CHARS,
  ProductFeedbackToolDraft,
  type ProductFeedbackElement,
} from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { create } from "zustand";

const decodeProductFeedbackToolDraft = Schema.decodeUnknownExit(ProductFeedbackToolDraft, {
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
}));

export function openProductFeedback(draft?: Partial<ProductFeedbackDraft>): void {
  useProductFeedbackStore.getState().openFeedback(draft);
}

export function productFeedbackDraftFromToolArgs(
  args: unknown,
): Partial<ProductFeedbackDraft> | null {
  const decoded = decodeProductFeedbackToolDraft(args);
  if (Exit.isFailure(decoded)) return null;
  return { feedback: decoded.value.feedback };
}

function appendBounded(current: string, proposed: string, maxLength: number): string {
  const left = current.trim();
  const right = proposed.trim();
  if (!left) return right.slice(0, maxLength);
  if (!right || left === right) return left.slice(0, maxLength);
  return `${left}\n\n${right}`.slice(0, maxLength);
}

export function openProductFeedbackFromToolArgs(args: unknown): boolean {
  const proposed = productFeedbackDraftFromToolArgs(args);
  if (!proposed?.feedback) return false;
  const current = useProductFeedbackStore.getState().draft;
  useProductFeedbackStore.getState().openFeedback({
    feedback: appendBounded(current.feedback, proposed.feedback, PRODUCT_FEEDBACK_TEXT_MAX_CHARS),
  });
  return true;
}
