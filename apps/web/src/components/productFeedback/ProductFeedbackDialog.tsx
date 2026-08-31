import { PRODUCT_FEEDBACK_TEXT_MAX_CHARS } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { startProductFeedbackElementPicker } from "../../productFeedbackPicker";
import {
  buildProductFeedbackSubmission,
  shouldRefreshProductFeedbackChallenge,
  submitProductFeedback,
} from "../../productFeedbackSubmission";
import { useProductFeedbackStore } from "../../productFeedbackStore";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";

interface TurnstileApi {
  readonly render: (
    container: HTMLElement,
    options: { readonly sitekey: string; readonly callback: (token: string) => void },
  ) => string;
  readonly remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

function TurnstileChallenge({
  siteKey,
  onToken,
}: {
  readonly siteKey: string;
  readonly onToken: (token: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let widgetId: string | null = null;
    let cancelled = false;
    const render = () => {
      if (cancelled || !containerRef.current || !window.turnstile) return;
      widgetId = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        callback: onToken,
      });
    };
    const existing = document.querySelector<HTMLScriptElement>("script[data-akeru-turnstile]");
    if (existing) {
      if (window.turnstile) render();
      else existing.addEventListener("load", render, { once: true });
    } else {
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      script.dataset.akeruTurnstile = "true";
      script.addEventListener("load", render, { once: true });
      document.head.append(script);
    }
    return () => {
      cancelled = true;
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
    };
  }, [onToken, siteKey]);
  return <div ref={containerRef} aria-label="Verification challenge" />;
}

export function ProductFeedbackDialog() {
  const settings = usePrimarySettings();
  const open = useProductFeedbackStore((state) => state.open);
  const picking = useProductFeedbackStore((state) => state.picking);
  const draft = useProductFeedbackStore((state) => state.draft);
  const closeFeedback = useProductFeedbackStore((state) => state.closeFeedback);
  const startPicking = useProductFeedbackStore((state) => state.startPicking);
  const stopPicking = useProductFeedbackStore((state) => state.stopPicking);
  const updateDraft = useProductFeedbackStore((state) => state.updateDraft);
  const clearDraft = useProductFeedbackStore((state) => state.clearDraft);
  const [submitting, setSubmitting] = useState(false);
  const [website, setWebsite] = useState("");
  const [status, setStatus] = useState<
    | { readonly kind: "idle" }
    | { readonly kind: "success"; readonly feedbackId: string }
    | { readonly kind: "failure"; readonly message: string }
  >({ kind: "idle" });
  const [challengeSiteKey, setChallengeSiteKey] = useState<string | null>(null);
  const [challengeAttempt, setChallengeAttempt] = useState(0);
  const [turnstileToken, setTurnstileToken] = useState<string | undefined>();

  useEffect(() => {
    if (open) setStatus({ kind: "idle" });
  }, [open]);

  useEffect(() => {
    if (!picking) return;
    const session = startProductFeedbackElementPicker({
      onPick: (element) => stopPicking(element),
      onCancel: () => stopPicking(),
    });
    return session.stop;
  }, [picking, stopPicking]);

  const payload = useMemo(
    () =>
      buildProductFeedbackSubmission({
        draft,
        website,
        ...(turnstileToken ? { turnstileToken } : {}),
      }),
    [draft, turnstileToken, website],
  );
  const canSend =
    settings.productFeedbackEnabled && draft.feedback.trim().length > 0 && !submitting;

  const handleClose = () => {
    closeFeedback();
    setWebsite("");
    setChallengeSiteKey(null);
    setTurnstileToken(undefined);
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSend) return;
    setSubmitting(true);
    setStatus({ kind: "idle" });
    const result = await submitProductFeedback(settings.productFeedbackEndpoint, payload);
    setSubmitting(false);
    if (result.ok) {
      setStatus({ kind: "success", feedbackId: result.receipt.feedbackId });
      clearDraft();
      setWebsite("");
      setChallengeSiteKey(null);
      setTurnstileToken(undefined);
      return;
    }
    setStatus({ kind: "failure", message: result.rejection.message });
    if (shouldRefreshProductFeedbackChallenge(payload, result)) {
      setTurnstileToken(undefined);
      setChallengeAttempt((attempt) => attempt + 1);
    }
    if (result.rejection.reason === "challenge_required" && result.rejection.challengeSiteKey) {
      setChallengeSiteKey(result.rejection.challengeSiteKey);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && handleClose()}>
      <DialogPopup
        className="flex max-h-[min(36rem,90dvh)] max-w-lg flex-col overflow-hidden"
        data-akeru-feedback-ui="composer"
      >
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={handleSubmit}>
          <DialogHeader className="shrink-0">
            <DialogTitle>Send feedback</DialogTitle>
          </DialogHeader>

          <DialogPanel className="space-y-3 px-5 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="product-feedback-text">Feedback</Label>
              <Textarea
                autoFocus
                className="min-h-52"
                id="product-feedback-text"
                maxLength={PRODUCT_FEEDBACK_TEXT_MAX_CHARS}
                placeholder="What happened?"
                value={draft.feedback}
                onChange={(event) => updateDraft({ feedback: event.currentTarget.value })}
              />
            </div>
            {draft.element ? (
              <div className="flex min-w-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs">
                <span className="min-w-0 flex-1 truncate">
                  {draft.element.label ?? draft.element.selector}
                </span>
                <Button
                  aria-label="Remove selected element"
                  size="micro"
                  type="button"
                  variant="ghost-muted"
                  onClick={() => updateDraft({ element: null })}
                >
                  Remove
                </Button>
              </div>
            ) : null}
            <input
              aria-hidden="true"
              autoComplete="off"
              name="website"
              tabIndex={-1}
              className="absolute -left-[10000px] size-px opacity-0"
              value={website}
              onChange={(event) => setWebsite(event.currentTarget.value)}
            />

            {challengeSiteKey ? (
              <TurnstileChallenge
                key={challengeAttempt}
                siteKey={challengeSiteKey}
                onToken={setTurnstileToken}
              />
            ) : null}

            {status.kind === "failure" ? (
              <p role="alert" className="text-sm text-destructive-foreground">
                {status.message}
              </p>
            ) : status.kind === "success" ? (
              <p role="status" className="text-sm text-foreground">
                Feedback sent. ID: <code>{status.feedbackId}</code>
              </p>
            ) : null}
            {!settings.productFeedbackEnabled ? (
              <p role="status" className="text-sm text-muted-foreground">
                Product feedback is disabled in Settings.
              </p>
            ) : null}
          </DialogPanel>

          <DialogFooter className="shrink-0">
            <div className="grid w-full grid-cols-2 gap-2 min-[360px]:grid-cols-[1fr_auto_auto]">
              <Button
                className="col-span-2 min-[360px]:col-span-1 min-[360px]:mr-auto"
                type="button"
                variant="outline"
                onClick={startPicking}
              >
                Choose an element
              </Button>
              <Button type="button" variant="ghost-muted" onClick={handleClose}>
                Cancel
              </Button>
              <Button disabled={!canSend} type="submit">
                {submitting ? "Sending..." : "Send"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
