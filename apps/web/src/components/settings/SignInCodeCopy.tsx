import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { useI18n } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

/**
 * Device sign-in code with a guarded copy action. Copy uses the shared clipboard
 * helper (with its plain-HTTP fallback); when the browser refuses, the code stays
 * selectable and the user is told to copy it by hand.
 */
export function SignInCodeCopy({
  code,
  className,
}: {
  readonly code: string;
  readonly className?: string;
}) {
  const { t } = useI18n();
  // The result belongs to the code it copied, so a replaced code starts idle.
  const [copyResult, setCopyResult] = useState<{
    readonly code: string;
    readonly state: "copied" | "failed";
  } | null>(null);
  const copyState = copyResult?.code === code ? copyResult.state : "idle";
  const copy = async () => {
    const copied = await writeTextToClipboard(code, "sign-in code").catch(() => false);
    setCopyResult({ code, state: copied ? "copied" : "failed" });
  };
  return (
    <div className="space-y-1.5">
      <div className={cn("flex items-center gap-2 rounded-lg bg-background px-3 py-2", className)}>
        <code className="flex-1 select-all text-sm font-semibold tracking-widest">{code}</code>
        <Button size="xs" variant="ghost" onClick={() => void copy()}>
          {copyState === "copied" ? (
            <CheckIcon className="size-3.5" />
          ) : (
            <CopyIcon className="size-3.5" />
          )}
          {copyState === "copied" ? t("Code copied") : t("Copy sign-in code")}
        </Button>
      </div>
      {copyState === "failed" ? (
        <p role="alert" className="text-xs text-muted-foreground">
          {t("Couldn't copy the code. Select it and copy it manually.")}
        </p>
      ) : null}
    </div>
  );
}
