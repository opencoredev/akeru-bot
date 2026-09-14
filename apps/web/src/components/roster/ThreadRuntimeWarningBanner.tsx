import { TriangleAlertIcon } from "lucide-react";

import { Alert, AlertDescription } from "../ui/alert";

export function ThreadRuntimeWarningBanner({ warning }: { readonly warning: string | null }) {
  if (!warning) return null;
  return (
    <div
      aria-live="polite"
      className="mx-auto w-fit max-w-[min(48rem,calc(100%-2rem))] pt-3"
      data-testid="thread-runtime-warning"
    >
      <Alert variant="warning" controlAlignment="first-line">
        <TriangleAlertIcon />
        <AlertDescription className="whitespace-pre-wrap">{warning}</AlertDescription>
      </Alert>
    </div>
  );
}
