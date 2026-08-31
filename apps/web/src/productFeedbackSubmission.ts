import {
  PRODUCT_FEEDBACK_TEXT_MAX_CHARS,
  ProductFeedbackReceipt,
  ProductFeedbackRejection,
  type ProductFeedbackSubmission,
} from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { randomUUID } from "./lib/utils";
import type { ProductFeedbackDraft } from "./productFeedbackStore";

const INSTALL_TOKEN_STORAGE_KEY = "akeru.product-feedback.install-token.v1";
const INSTALL_TOKEN_MAX_AGE_MS = 30 * 86_400_000;
const INSTALL_TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decodeProductFeedbackReceipt = Schema.decodeUnknownExit(ProductFeedbackReceipt);
const decodeProductFeedbackRejection = Schema.decodeUnknownExit(ProductFeedbackRejection);

interface StoredInstallToken {
  readonly token: string;
  readonly createdAt: number;
}

function newInstallToken(): StoredInstallToken {
  return { token: randomUUID(), createdAt: Date.now() };
}

export function readOrRotateProductFeedbackInstallToken(force = false): string {
  let stored: StoredInstallToken | null = null;
  const current = Date.now();
  try {
    const raw = globalThis.localStorage?.getItem(INSTALL_TOKEN_STORAGE_KEY);
    if (raw) {
      const value: unknown = JSON.parse(raw);
      if (
        typeof value === "object" &&
        value !== null &&
        "token" in value &&
        "createdAt" in value &&
        typeof value.token === "string" &&
        INSTALL_TOKEN_PATTERN.test(value.token) &&
        typeof value.createdAt === "number" &&
        Number.isSafeInteger(value.createdAt) &&
        value.createdAt >= 0 &&
        value.createdAt <= current
      ) {
        stored = { token: value.token, createdAt: value.createdAt };
      }
    }
  } catch {
    stored = null;
  }
  if (force || !stored || current - stored.createdAt >= INSTALL_TOKEN_MAX_AGE_MS) {
    stored = newInstallToken();
    try {
      globalThis.localStorage?.setItem(INSTALL_TOKEN_STORAGE_KEY, JSON.stringify(stored));
    } catch {
      // Private browsing and storage quotas must not block feedback submission.
    }
  }
  return stored.token;
}

export function buildProductFeedbackSubmission(input: {
  readonly draft: ProductFeedbackDraft;
  readonly website?: string | undefined;
  readonly turnstileToken?: string | undefined;
}): ProductFeedbackSubmission {
  const feedback = input.draft.feedback.trim().slice(0, PRODUCT_FEEDBACK_TEXT_MAX_CHARS);
  return {
    schemaVersion: 1,
    feedback,
    ...(input.draft.element ? { element: input.draft.element } : {}),
    installToken: readOrRotateProductFeedbackInstallToken(),
    ...(input.turnstileToken ? { turnstileToken: input.turnstileToken } : {}),
    website: input.website ?? "",
  };
}

export type ProductFeedbackSubmitResult =
  | { readonly ok: true; readonly receipt: ProductFeedbackReceipt }
  | { readonly ok: false; readonly rejection: ProductFeedbackRejection };

export function shouldRefreshProductFeedbackChallenge(
  submission: ProductFeedbackSubmission,
  result: ProductFeedbackSubmitResult,
): boolean {
  return Boolean(submission.turnstileToken) && !result.ok;
}

export async function submitProductFeedback(
  endpoint: string,
  submission: ProductFeedbackSubmission,
): Promise<ProductFeedbackSubmitResult> {
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(submission),
    });
    const body: unknown = await response.json();
    if (response.ok) {
      const decoded = decodeProductFeedbackReceipt(body);
      if (Exit.isSuccess(decoded)) return { ok: true, receipt: decoded.value };
    } else {
      const decoded = decodeProductFeedbackRejection(body);
      if (Exit.isSuccess(decoded)) return { ok: false, rejection: decoded.value };
    }
  } catch {
    // The bounded message below is the only network detail shown to the user.
  }
  return {
    ok: false,
    rejection: {
      reason: "internal",
      message: "Akeru could not send the feedback. Your draft is still available.",
    },
  };
}
