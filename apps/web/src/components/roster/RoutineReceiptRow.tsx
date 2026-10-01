import { ChevronRightIcon, CircleAlertIcon, CircleCheckIcon, Clock3Icon } from "lucide-react";

import { cn } from "~/lib/utils";

import { useI18n } from "../../i18n";
import { routineReceiptLabelText, type RoutineReceipt } from "./routineReceipts";

/** A routine run note in a bot chat. Opens Routines when the routine still exists. */
export function RoutineReceiptRow({
  receipt,
  onOpenRoutines,
}: {
  readonly receipt: RoutineReceipt;
  readonly onOpenRoutines?: () => void;
}) {
  const { t, formatDate } = useI18n();

  const Icon =
    receipt.tone === "error"
      ? CircleAlertIcon
      : receipt.tone === "success"
        ? CircleCheckIcon
        : Clock3Icon;

  const error = receipt.tone === "error";
  const opensRoutines = !receipt.archived && !!onOpenRoutines;
  const Row = opensRoutines ? "button" : "div";

  return (
    <Row
      {...(opensRoutines
        ? {
            type: "button" as const,
            "aria-label": t("{text}. Open Routines", {
              text: routineReceiptLabelText(receipt.text),
            }),
          }
        : {})}
      className={cn(
        "mx-auto flex w-full max-w-3xl items-start gap-2 rounded-md px-2 py-2 text-xs text-muted-foreground",
        opensRoutines &&
          "outline-none transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        error && "bg-destructive/8 text-destructive-foreground",
        error && opensRoutines && "hover:bg-destructive/12 hover:text-destructive-foreground",
      )}
      data-testid="routine-receipt"
      onClick={opensRoutines ? onOpenRoutines : undefined}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 whitespace-normal break-words text-left leading-5">
        {receipt.text}
      </span>
      <time className="shrink-0 text-11px text-muted-foreground/60" dateTime={receipt.createdAt}>
        {formatDate(new Date(receipt.createdAt), { hour: "numeric", minute: "2-digit" })}
      </time>
      {opensRoutines ? (
        <ChevronRightIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 opacity-60" />
      ) : null}
    </Row>
  );
}
