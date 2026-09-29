import { MicIcon, RotateCcwIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect, useId, useRef } from "react";

export interface DictationControlsProps {
  status: "idle" | "requesting" | "recording" | "transcribing" | "canceled" | "failed";
  unavailableReason?: string | null;
  errorMessage?: string | null;
  appearance?: "labeled" | "send-slot";
  onStart: () => void;
  onRelease: () => void;
  onCancel: () => void;
  /** Send-slot only: the blocked mic stays pressable so it can explain the unavailable reason. */
  onBlockedPress?: (reason: string) => void;
}

const announcements = {
  idle: "Dictation ready.",
  requesting: "Requesting microphone access…",
  recording: "Recording dictation.",
  transcribing: "Transcribing dictation…",
  canceled: "Dictation canceled.",
  failed: "Dictation failed. Try again.",
};

export function DictationControls({
  status,
  unavailableReason,
  appearance = "labeled",
  onStart,
  onRelease,
  onCancel,
  onBlockedPress,
}: DictationControlsProps) {
  const descriptionId = useId();
  const pointer = useRef<number | null>(null);
  const suppressClick = useRef(false);
  const holdStartedAt = useRef(0);
  const startedThisGesture = useRef(false);
  const active = status === "requesting" || status === "recording";
  const busy = active || status === "transcribing";
  // Send-slot only: a failed dictation stays in the slot as a retry until it is dismissed.
  const retry = appearance === "send-slot" && status === "failed" && !unavailableReason;
  const blocked = Boolean(unavailableReason);
  const explainsBlock = appearance === "send-slot" && blocked && onBlockedPress !== undefined;
  const disabled =
    (appearance === "labeled" && status === "transcribing") || (blocked && !explainsBlock);
  const operation = useRef(busy);
  const cancelCallback = useRef(onCancel);
  useEffect(() => {
    cancelCallback.current = onCancel;
  }, [onCancel]);
  useEffect(() => {
    operation.current = busy;
  }, [status]);
  const cancel = () => {
    pointer.current = null;
    if (!operation.current) return;
    operation.current = false;
    cancelCallback.current();
  };
  useEffect(() => {
    if (!blocked) return;
    // A blocked slot cannot retry, so settle a failed dictation and give the send slot back.
    if (status === "failed") cancelCallback.current();
    else cancel();
  }, [blocked, status]);
  useEffect(() => () => cancel(), []);
  const start = () => {
    operation.current = true;
    onStart();
  };
  const toggle = () => {
    if (explainsBlock) {
      onBlockedPress(unavailableReason!);
      return;
    }
    if (disabled) return;
    if (appearance === "send-slot" && status === "transcribing") {
      cancel();
      return;
    }
    if (active) onRelease();
    else start();
  };
  const label =
    appearance === "send-slot" && status === "transcribing"
      ? "Cancel dictation"
      : active
        ? "Stop dictation"
        : retry
          ? "Retry dictation"
          : "Start dictation";
  const statusText = unavailableReason
    ? `Dictation unavailable: ${unavailableReason}`
    : announcements[status];

  const button = (
    <button
      type="button"
      className={
        appearance === "send-slot"
          ? `flex size-full items-center justify-center rounded-full transition-colors disabled:opacity-50 aria-disabled:opacity-50 ${
              active ? "bg-destructive text-white" : "bg-foreground text-background"
            }`
          : "min-h-11 rounded-md border px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
      }
      style={{ touchAction: "none", userSelect: "none" }}
      disabled={disabled}
      aria-disabled={explainsBlock || undefined}
      aria-label={label}
      aria-pressed={active}
      aria-describedby={`${descriptionId} ${descriptionId}-status`}
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary || disabled || pointer.current !== null) return;
        if (explainsBlock) return;
        if (appearance === "send-slot" && status === "transcribing") return;
        event.preventDefault();
        suppressClick.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        pointer.current = event.pointerId;
        holdStartedAt.current = Date.now();
        startedThisGesture.current = !active;
        if (!active) start();
      }}
      onPointerUp={(event) => {
        if (pointer.current !== event.pointerId) return;
        pointer.current = null;
        const heldMs = Date.now() - holdStartedAt.current;
        // A tap starts recording; only a real hold finishes on release.
        if (appearance === "send-slot" && startedThisGesture.current && heldMs < 220) return;
        onRelease();
      }}
      onPointerCancel={(event) => {
        if (pointer.current === event.pointerId) cancel();
      }}
      onLostPointerCapture={(event) => {
        if (pointer.current === event.pointerId) cancel();
      }}
      onClick={(event) => {
        // Pointer release already finished the hold; keyboard and AT clicks have detail zero.
        if (event.detail !== 0 && suppressClick.current) {
          suppressClick.current = false;
          return;
        }
        suppressClick.current = false;
        toggle();
      }}
    >
      {appearance === "send-slot" ? (
        status === "transcribing" ? (
          <SquareIcon className="size-3.5 fill-current" aria-hidden="true" />
        ) : retry ? (
          <RotateCcwIcon className="size-4.5" aria-hidden="true" />
        ) : (
          <MicIcon className="size-5" aria-hidden="true" />
        )
      ) : active ? (
        "Stop dictation"
      ) : (
        "Dictate"
      )}
    </button>
  );

  if (appearance === "send-slot") {
    return (
      <div className="relative size-full">
        {button}
        {active && (
          <button
            type="button"
            className="absolute top-1/2 right-full mr-1.5 flex size-7 -translate-y-1/2 items-center justify-center rounded-full border bg-background text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            aria-label="Cancel dictation"
            onClick={cancel}
          >
            <XIcon className="size-3.5" aria-hidden="true" />
          </button>
        )}
        {retry && (
          <button
            type="button"
            className="absolute top-1/2 right-full mr-1.5 flex size-7 -translate-y-1/2 items-center justify-center rounded-full border bg-background text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            aria-label="Dismiss dictation error"
            onClick={() => cancelCallback.current()}
          >
            <XIcon className="size-3.5" aria-hidden="true" />
          </button>
        )}
        <span id={descriptionId} className="sr-only">
          Hold to dictate and release to finish, or activate to start and activate again to stop.
        </span>
        <span
          id={`${descriptionId}-status`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
        >
          {statusText}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {button}
      {busy && (
        <button
          type="button"
          className="min-h-11 rounded-md border px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring"
          onClick={cancel}
        >
          Cancel dictation
        </button>
      )}
      <span id={descriptionId} className="text-xs text-muted-foreground">
        Hold to dictate and release to finish, or activate to start and activate again to stop.
      </span>
      <span
        id={`${descriptionId}-status`}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="text-xs text-muted-foreground"
      >
        {statusText}
      </span>
    </div>
  );
}
