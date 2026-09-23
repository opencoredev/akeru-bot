import { CircleAlertIcon, XIcon } from "lucide-react";
import { memo, useState } from "react";

import { presentThreadError, type ThreadErrorContext } from "@t3tools/client-runtime/errors";
import type { EnvironmentId } from "@t3tools/contracts";

import { useI18n } from "../../i18n";
import { openProductFeedbackWithPrefill } from "../../productFeedbackStore";
import { Button } from "../ui/button";
import { ProviderRepairAction } from "./ProviderUnavailableNotice";

export function threadErrorFeedbackDraft(error: string): string {
  const presentation = presentThreadError(error);
  return `A request failed in a bot chat.\n\n${presentation.title}\n${presentation.description}`;
}

export function getThreadErrorBannerKey(threadKey: string, error: string | null): string | null {
  return error === null ? null : `${threadKey}\u0000${error}`;
}

export function shouldShowThreadErrorBanner(
  threadKey: string,
  error: string | null,
  isDismissed: boolean,
): boolean {
  return getThreadErrorBannerKey(threadKey, error) !== null && !isDismissed;
}

const sessionDismissedThreadErrorBannerKeys = new Set<string>();

export function dismissThreadErrorBannerForSession(bannerKey: string | null): void {
  if (bannerKey !== null) {
    sessionDismissedThreadErrorBannerKeys.add(bannerKey);
  }
}

export function isThreadErrorBannerDismissedForSession(bannerKey: string | null): boolean {
  return bannerKey !== null && sessionDismissedThreadErrorBannerKeys.has(bannerKey);
}

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  threadKey,
  onDismiss,
  onResume,
  resuming = false,
  context,
  environmentId = null,
  onOpenUsage,
}: {
  error: string | null;
  threadKey: string;
  /** The failure's category and names, when the server reported them. */
  context?: ThreadErrorContext;
  environmentId?: EnvironmentId | null;
  onOpenUsage?: () => void;
  onDismiss?: () => void;
  onResume?: () => void;
  resuming?: boolean;
}) {
  const { t } = useI18n();
  const [locallyDismissedKey, setLocallyDismissedKey] = useState<string | null>(null);
  const bannerKey = getThreadErrorBannerKey(threadKey, error);
  if (
    !error ||
    bannerKey === locallyDismissedKey ||
    isThreadErrorBannerDismissedForSession(bannerKey)
  ) {
    return null;
  }

  const presentation = presentThreadError(error, context);
  const dismiss = () => {
    dismissThreadErrorBannerForSession(bannerKey);
    setLocallyDismissedKey(bannerKey);
    onDismiss?.();
  };

  return (
    <div className="mx-auto w-[min(46rem,calc(100%-2rem))] pt-2">
      <section
        aria-atomic="true"
        className="relative rounded-xl border border-destructive/20 bg-card px-3 py-2.5 pe-10 text-card-foreground shadow-sm"
        role="alert"
      >
        <Button
          aria-label={t("Dismiss error")}
          className="absolute end-2 top-2 text-muted-foreground hover:text-foreground"
          onClick={dismiss}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <XIcon />
        </Button>

        <div className="flex min-w-0 items-start gap-2.5">
          <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium leading-5">{presentation.title}</p>
            <p className="mt-0.5 text-xs leading-4.5 text-muted-foreground">
              {presentation.description}
            </p>

            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {onResume ? (
                <Button size="xs" type="button" onClick={onResume} disabled={resuming}>
                  {resuming ? t("Resuming…") : t("Resume")}
                </Button>
              ) : null}
              <ProviderRepairAction
                action={presentation.action}
                environmentId={environmentId}
                onOpenUsage={onOpenUsage}
              />
              {presentation.action === "feedback" ? (
                <Button
                  size="xs"
                  type="button"
                  variant="outline"
                  onClick={() => openProductFeedbackWithPrefill(threadErrorFeedbackDraft(error))}
                >
                  {t("Send feedback")}
                </Button>
              ) : null}
            </div>

            <details className="mt-1.5 text-xs text-muted-foreground">
              <summary className="w-fit cursor-pointer rounded-sm py-0.5 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                {t("Technical details")}
              </summary>
              <pre className="mt-1.5 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 px-2 py-1.5 font-mono text-[11px] leading-4 text-foreground/75">
                {presentation.technicalDetails}
              </pre>
            </details>
          </div>
        </div>
      </section>
    </div>
  );
});
