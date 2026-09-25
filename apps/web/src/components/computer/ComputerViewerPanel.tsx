import {
  ArrowTurnBackwardIcon,
  CursorPointer01Icon,
  PlayIcon,
  StopCircleIcon,
} from "@hugeicons/core-free-icons";
import {
  computerFramePoint,
  computerKeyAction,
  type ComputerCapabilityExplanation,
  type ComputerViewerNotice,
  type ComputerViewerView,
} from "@t3tools/client-runtime/state/computer-viewer";
import type { ComputerAction, ComputerFrame } from "@t3tools/contracts";
import { useRef, type KeyboardEvent, type PointerEvent, type WheelEvent } from "react";

import { useI18n } from "../../i18n";
import { AppIcon } from "../ui/app-icon";
import { Button } from "../ui/button";

const MOVE_INTERVAL_MS = 100;
const MAX_SCROLL = 2000;
const MAX_TYPED_TEXT = 4096;

export interface ComputerViewerPanelProps {
  readonly botName: string;
  readonly view: ComputerViewerView;
  readonly frame: ComputerFrame | null;
  readonly notice: ComputerViewerNotice | null;
  readonly capability: ComputerCapabilityExplanation;
  readonly onTakeControl: () => void;
  readonly onReturnControl: () => void;
  readonly onStop: () => void;
  readonly onResume: () => void;
  readonly onInput: (action: ComputerAction) => void;
}

function pointerButton(button: number): "left" | "middle" | "right" | null {
  if (button === 0) return "left";
  if (button === 1) return "middle";
  if (button === 2) return "right";
  return null;
}

function OwnerBadge({ botName, view }: Pick<ComputerViewerPanelProps, "botName" | "view">) {
  const { t } = useI18n();
  const label = (() => {
    switch (view.owner) {
      case "bot":
        return t("{name} is in control", { name: botName });
      case "you":
        return t("You are in control");
      case "someone-else":
        return t("Someone else is in control");
      case "nobody":
        return t("No one is in control");
    }
  })();
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs font-medium"
      data-computer-owner={view.owner}
    >
      <span
        aria-hidden="true"
        className={
          view.owner === "you"
            ? "size-1.5 rounded-full bg-primary"
            : view.owner === "nobody"
              ? "size-1.5 rounded-full bg-muted-foreground/50"
              : "size-1.5 rounded-full bg-success"
        }
      />
      {label}
    </span>
  );
}

function NoticeMessage({ notice }: { readonly notice: ComputerViewerNotice }) {
  const { t } = useI18n();
  switch (notice) {
    case "expired":
      return t("Your minute of control ran out, so the computer stopped. Resume it to continue.");
    case "revoked":
      return t("Your control ended.");
    case "stopped":
      return t("The computer stopped.");
    case "ended":
      return t("The computer is no longer available. The bot's work may have ended.");
    case "disconnected":
      return t("The connection dropped, so your control ended and the computer stopped.");
    case "busy":
      return t("Someone else took control first.");
    case "failed":
      return t("The computer did not accept that. Try again.");
  }
}

export function CapabilityMessage({
  botName,
  capability,
}: {
  readonly botName: string;
  readonly capability: ComputerCapabilityExplanation;
}) {
  const { t } = useI18n();
  switch (capability) {
    case "local":
      return t(
        "{name} works in a local workspace, which has no desktop to watch. Choose a Daytona sandbox in bot settings to give it a computer.",
        { name: botName },
      );
    case "sandbox":
      return t(
        "This bot's sandbox has no graphical desktop. Only Daytona sandboxes provide a computer you can watch and control.",
      );
    case "provider":
      return t(
        "Computer control needs a Codex or Kimi For Coding engine. Claude, Grok, and OpenCode bots cannot share a computer yet.",
      );
    case "not-running":
      return t(
        "The computer starts when {name} begins work in its Daytona sandbox. Send it a message, then open the computer again.",
        { name: botName },
      );
    case "available":
      return t("This computer is unavailable right now.");
  }
}

/** Renders one computer: the latest frame, who is in control, and the control actions. */
export function ComputerViewerPanel(props: ComputerViewerPanelProps) {
  const { botName, view, frame, notice } = props;
  const { t } = useI18n();
  const lastMoveRef = useRef(0);

  const point = (event: PointerEvent<HTMLElement> | WheelEvent<HTMLElement>) =>
    frame === null
      ? null
      : computerFramePoint({
          frame,
          rect: event.currentTarget.getBoundingClientRect(),
          clientX: event.clientX,
          clientY: event.clientY,
        });

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (!view.canSendInput) return;
    const button = pointerButton(event.button);
    const target = point(event);
    event.currentTarget.focus();
    if (button === null || target === null) return;
    event.preventDefault();
    props.onInput({ _tag: "click", x: target.x, y: target.y, button });
  };

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    if (!view.canSendInput || event.timeStamp - lastMoveRef.current < MOVE_INTERVAL_MS) return;
    const target = point(event);
    if (target === null) return;
    lastMoveRef.current = event.timeStamp;
    props.onInput({ _tag: "move", x: target.x, y: target.y });
  };

  const onWheel = (event: WheelEvent<HTMLElement>) => {
    if (!view.canSendInput || event.deltaY === 0) return;
    props.onInput({
      _tag: "scroll",
      direction: event.deltaY > 0 ? "down" : "up",
      amount: Math.min(MAX_SCROLL, Math.max(1, Math.round(Math.abs(event.deltaY)))),
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!view.canSendInput || event.nativeEvent.isComposing) return;
    const action = computerKeyAction(event);
    if (action === null) return;
    event.preventDefault();
    event.stopPropagation();
    props.onInput(action);
  };

  const status = (() => {
    switch (view.phase) {
      case "hidden":
      case "connecting":
        return t("Connecting to the computer…");
      case "reconnecting":
        return t("Reconnecting to the computer…");
      case "stopped":
        return t("The computer is stopped.");
      case "unsupported":
        return <CapabilityMessage botName={botName} capability={props.capability} />;
      case "live":
        return frame === null ? t("Waiting for the first picture…") : null;
    }
  })();

  return (
    <div className="flex min-h-0 flex-col gap-3" data-computer-phase={view.phase}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <OwnerBadge botName={botName} view={view} />
        <div className="flex flex-wrap items-center gap-2">
          {view.phase === "live" && view.owner !== "you" ? (
            <Button
              size="sm"
              disabled={!view.canTakeControl}
              onClick={props.onTakeControl}
              data-computer-action="take"
            >
              <AppIcon className="size-4" icon={CursorPointer01Icon} />
              {t("Take control")}
            </Button>
          ) : null}
          {view.owner === "you" ? (
            <Button
              size="sm"
              disabled={!view.canReturnControl}
              onClick={props.onReturnControl}
              data-computer-action="return"
            >
              <AppIcon className="size-4" icon={ArrowTurnBackwardIcon} />
              {t("Return to {name}", { name: botName })}
            </Button>
          ) : null}
          {view.phase === "live" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={!view.canStop}
              onClick={props.onStop}
              data-computer-action="stop"
            >
              <AppIcon className="size-4" icon={StopCircleIcon} />
              {t("Stop")}
            </Button>
          ) : null}
          {view.phase === "stopped" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={!view.canResume}
              onClick={props.onResume}
              data-computer-action="resume"
            >
              <AppIcon className="size-4" icon={PlayIcon} />
              {t("Resume")}
            </Button>
          ) : null}
        </div>
      </div>

      {notice ? (
        <p role="status" className="text-sm text-warning" data-computer-notice={notice}>
          <NoticeMessage notice={notice} />
        </p>
      ) : null}
      {view.controlUnavailableReason ? (
        <p className="text-sm text-muted-foreground">
          {t("Control is unavailable: {reason}", { reason: view.controlUnavailableReason })}
        </p>
      ) : null}

      {view.phase === "live" && frame !== null ? (
        <div
          role="application"
          aria-label={t("{name}'s screen", { name: botName })}
          tabIndex={view.canSendInput ? 0 : -1}
          className={
            view.canSendInput
              ? "relative mx-auto w-full overflow-hidden rounded-lg border-2 border-primary outline-none"
              : "relative mx-auto w-full overflow-hidden rounded-lg border border-border outline-none"
          }
          style={{ aspectRatio: `${frame.width} / ${frame.height}`, maxWidth: frame.width }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onWheel={onWheel}
          onKeyDown={onKeyDown}
          onPaste={(event) => {
            if (!view.canSendInput) return;
            const text = event.clipboardData.getData("text/plain").slice(0, MAX_TYPED_TEXT);
            if (text.length === 0) return;
            event.preventDefault();
            props.onInput({ _tag: "type", text });
          }}
          onContextMenu={(event) => {
            if (view.canSendInput) event.preventDefault();
          }}
        >
          <img
            alt=""
            draggable={false}
            className="block size-full select-none"
            src={`data:${frame.mimeType};base64,${frame.data}`}
          />
        </div>
      ) : (
        <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-border px-6 py-10 text-center text-sm text-muted-foreground">
          <p className="max-w-md">{status}</p>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {view.owner === "you"
          ? t(
              "Click, type, paste, and scroll on the picture. Control lasts up to one minute, then the computer stops.",
            )
          : t(
              "You see the screen the bot works on. Pictures are streamed while this window is open and are not saved.",
            )}
      </p>
    </div>
  );
}
