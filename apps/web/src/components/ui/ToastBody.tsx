import { Predicate } from "effect";
import { Toast } from "@base-ui/react/toast";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CopyIcon,
  InfoIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { Button, buttonVariants } from "~/components/ui/button";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useI18n } from "~/i18n";
import { hasVisibleToastAction } from "./toast.logic";
import type { ThreadToastData } from "./toastState";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";

const TOAST_ICONS = {
  error: CircleAlertIcon,
  info: InfoIcon,
  loading: LoaderCircleIcon,
  success: CircleCheckIcon,
  warning: TriangleAlertIcon,
} as const;

/** Visually shorten long error bodies; clipboard copy still uses the full `description` string. */
const ERROR_DESCRIPTION_CLAMP_MIN_CHARS = 180;

function errorDescriptionClampClass(type: unknown, description: unknown): string | undefined {
  if (type !== "error" || !Predicate.isString(description)) {
    return undefined;
  }

  if (description.length < ERROR_DESCRIPTION_CLAMP_MIN_CHARS) {
    return undefined;
  }

  return "line-clamp-4";
}

/** Dismiss-only: circular control overlapping the card corner (iOS notification–style). */
export const toastCornerDismissClass = "absolute z-20 -top-1.5 -right-1.5";

export const toastCornerOrbClass = cn(
  "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border/60 bg-popover text-muted-foreground shadow-sm outline-none",
  "transition-[color,background-color,box-shadow] hover:bg-popover hover:text-foreground",
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
);

function CopyErrorButton({ text }: { text: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "error-message" });
  const { t } = useI18n();
  const label = isCopied ? t("Copied error") : t("Copy error");

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-micro"
            variant="ghost-muted"
            aria-label={label}
            className="[--control-icon-color:currentColor] rounded-md text-muted-foreground/80 hover:bg-transparent hover:text-muted-foreground"
            onClick={() => copyToClipboard(text)}
          />
        }
      >
        {isCopied ? <CheckIcon className="size-3 text-success" /> : <CopyIcon className="size-3" />}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** Scrollable cap for long expandable lists (~10rem); keeps the toast from growing without bound. */
const toastExpandablePanelClassName =
  "mt-2 max-h-40 min-h-0 overflow-y-auto overscroll-contain pr-0.5 select-text";

function ToastExpandableSection({
  children,
  labels,
}: {
  children: ReactNode;
  labels: { expand?: string; collapse?: string };
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const expandLabel = labels.expand ?? t("Show details");
  const collapseLabel = labels.collapse ?? t("Hide details");

  return (
    <div className="min-w-0">
      <button
        aria-expanded={open}
        className="inline-flex cursor-pointer items-center gap-1 rounded-md py-0.5 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => setOpen((prev) => !prev)}
        type="button"
      >
        {open ? (
          <ChevronUpIcon className="size-3.5 shrink-0 opacity-80" strokeWidth={2.25} />
        ) : (
          <ChevronDownIcon className="size-3.5 shrink-0 opacity-80" strokeWidth={2.25} />
        )}
        {open ? collapseLabel : expandLabel}
      </button>
      {open ? <div className={toastExpandablePanelClassName}>{children}</div> : null}
    </div>
  );
}

function ToastDescriptionAndExpandable({
  toastData,
  toastDescription,
  toastType,
}: {
  toastData: ThreadToastData | undefined;
  toastDescription: unknown;
  toastType: unknown;
}) {
  const expandableContent = toastData?.expandableContent;
  const labels = toastData?.expandableLabels ?? {};
  const descriptionTrigger = toastData?.expandableDescriptionTrigger ?? false;
  const { t } = useI18n();

  const descriptionClassName = cn(
    "min-w-0 select-text wrap-break-word text-muted-foreground",
    errorDescriptionClampClass(toastType, toastDescription),
  );

  const [open, setOpen] = useState(false);

  if (!expandableContent) {
    return <Toast.Description className={descriptionClassName} data-slot="toast-description" />;
  }

  if (!descriptionTrigger) {
    return (
      <>
        <Toast.Description className={descriptionClassName} data-slot="toast-description" />
        <ToastExpandableSection labels={labels}>{expandableContent}</ToastExpandableSection>
      </>
    );
  }

  const expandLabel = labels.expand ?? t("Show details");
  const collapseLabel = labels.collapse ?? t("Hide details");

  const toggle = () => setOpen((v) => !v);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
    }
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <div
              aria-label={open ? collapseLabel : expandLabel}
              aria-expanded={open}
              className={cn(
                "group flex min-w-0 w-full cursor-pointer select-none items-start gap-1.5 rounded-sm text-left outline-none ring-offset-background",
                "transition-colors hover:bg-muted/40",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
              )}
              onClick={toggle}
              onKeyDown={onKeyDown}
              role="button"
              tabIndex={0}
            />
          }
        >
          <div className="min-w-0 flex-1">
            <Toast.Description
              className={cn(
                "min-w-0 select-none wrap-break-word text-muted-foreground",
                errorDescriptionClampClass(toastType, toastDescription),
                "underline-offset-2 decoration-muted-foreground/60 group-hover:underline",
              )}
              data-slot="toast-description"
            />
          </div>
          {open ? (
            <ChevronUpIcon
              aria-hidden
              className="mt-0.5 size-3.5 shrink-0 text-muted-foreground opacity-80"
              strokeWidth={2.25}
            />
          ) : (
            <ChevronDownIcon
              aria-hidden
              className="mt-0.5 size-3.5 shrink-0 text-muted-foreground opacity-80"
              strokeWidth={2.25}
            />
          )}
        </TooltipTrigger>
        <TooltipPopup side="top">{open ? collapseLabel : expandLabel}</TooltipPopup>
      </Tooltip>
      {open ? <div className={toastExpandablePanelClassName}>{expandableContent}</div> : null}
    </>
  );
}

type ToastIconComponent = (typeof TOAST_ICONS)[keyof typeof TOAST_ICONS];

interface ToastBodyDescriptor {
  readonly Icon: ToastIconComponent | null | undefined;
  readonly stackedActionLayout: boolean;
  readonly actionVariant: NonNullable<ThreadToastData["actionVariant"]>;
  readonly secondaryActionVariant: NonNullable<ThreadToastData["secondaryActionVariant"]>;
  readonly copyErrorText: string | null;
  readonly hasTrailingControls: boolean;
  readonly inlineContentEndPad: string;
}

export function deriveToastBodyDescriptor(toast: {
  readonly type?: string | undefined;
  readonly description?: unknown;
  readonly actionProps?: unknown;
  readonly data?: ThreadToastData | undefined;
}): ToastBodyDescriptor {
  const Icon = toast.type ? TOAST_ICONS[toast.type as keyof typeof TOAST_ICONS] : null;

  const stackedActionLayout =
    hasVisibleToastAction(toast.actionProps) && toast.data?.actionLayout === "stacked-end";

  const actionVariant: NonNullable<ThreadToastData["actionVariant"]> =
    toast.data?.actionVariant ?? "default";

  const secondaryActionVariant: NonNullable<ThreadToastData["secondaryActionVariant"]> =
    toast.data?.secondaryActionVariant ?? "outline";

  const copyErrorText =
    toast.type === "error" && Predicate.isString(toast.description) && !toast.data?.hideCopyButton
      ? toast.description
      : null;

  const hasAdditionalActions = (toast.data?.additionalActions?.length ?? 0) > 0;
  const hasSecondaryAction = toast.data?.secondaryActionProps !== undefined;

  const hasTrailingControls =
    copyErrorText !== null ||
    hasVisibleToastAction(toast.actionProps) ||
    hasAdditionalActions ||
    hasSecondaryAction;

  const inlineContentEndPad = hasTrailingControls ? "pr-6" : "pr-10";

  return {
    Icon,
    stackedActionLayout,
    actionVariant,
    secondaryActionVariant,
    copyErrorText,
    hasTrailingControls,
    inlineContentEndPad,
  };
}

interface ToastBodyContentProps extends ToastBodyDescriptor {
  readonly actionProps: { readonly children?: ReactNode } | undefined;
  readonly toastData: ThreadToastData | undefined;
  readonly toastDescription: unknown;
  readonly toastType: unknown;
}

export function ToastBodyContent({
  stackedActionLayout,
  Icon,
  copyErrorText,
  actionProps,
  actionVariant,
  secondaryActionVariant,
  hasTrailingControls,
  toastData,
  toastDescription,
  toastType,
}: ToastBodyContentProps) {
  const additionalActions = toastData?.additionalActions ?? [];
  const secondaryActionProps = toastData?.secondaryActionProps;
  const leadingIcon = toastData?.leadingIcon;

  const { className: secondaryActionClassName, ...secondaryActionRest } =
    secondaryActionProps ?? {};

  return (
    <>
      <div className={cn("flex min-w-0 gap-2", !stackedActionLayout && "flex-1")}>
        {leadingIcon ? (
          <div
            className="flex h-lh w-4 shrink-0 items-center justify-center"
            data-slot="toast-icon"
          >
            {leadingIcon}
          </div>
        ) : Icon ? (
          <div
            className="[&>svg]:h-lh [&>svg]:w-4 [&_svg]:pointer-events-none [&_svg]:shrink-0"
            data-slot="toast-icon"
          >
            <Icon className="in-data-[type=loading]:animate-spin in-data-[type=error]:text-destructive in-data-[type=info]:text-info in-data-[type=success]:text-success in-data-[type=warning]:text-warning in-data-[type=loading]:opacity-80" />
          </div>
        ) : null}
        <div
          className={cn(
            "flex min-h-0 min-w-0 flex-1 flex-col gap-0.5",
            stackedActionLayout && "pr-5",
          )}
        >
          <Toast.Title className="min-w-0 wrap-break-word font-medium" data-slot="toast-title" />
          <ToastDescriptionAndExpandable
            toastData={toastData}
            toastDescription={toastDescription}
            toastType={toastType}
          />
        </div>
      </div>
      {hasTrailingControls ? (
        <div
          className={cn(
            "flex items-center gap-1.5",
            stackedActionLayout ? "w-full justify-end" : "shrink-0",
          )}
        >
          {copyErrorText !== null ? <CopyErrorButton text={copyErrorText} /> : null}
          {additionalActions.map(({ id, props: { className, ...props } }) => (
            <Button
              {...props}
              className={className}
              key={id}
              size="xs"
              type="button"
              variant={secondaryActionVariant}
            />
          ))}
          {secondaryActionProps ? (
            <Button
              {...secondaryActionRest}
              className={secondaryActionClassName}
              size="xs"
              type="button"
              variant={secondaryActionVariant}
            />
          ) : null}
          {hasVisibleToastAction(actionProps) ? (
            <Toast.Action
              className={cn(buttonVariants({ size: "xs", variant: actionVariant }), "shrink-0")}
              data-slot="toast-action"
            >
              {actionProps?.children}
            </Toast.Action>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
