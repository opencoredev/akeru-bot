import { useSyncExternalStore } from "react";
import { PauseIcon, PlayIcon, SquareIcon, Volume2Icon } from "lucide-react";
import {
  sameReplyPlaybackIdentity,
  type ReplyPlaybackController,
  type ReplyPlaybackRequest,
} from "@t3tools/client-runtime/reply-playback";

import { useI18n } from "../../i18n";
import { Button } from "../ui/button";

export interface ReplyPlaybackControlsProps {
  readonly controller: ReplyPlaybackController;
  readonly request: ReplyPlaybackRequest;
  readonly unavailableReason?: string;
  readonly disclosure?: string;
}

export function ReplyPlaybackControls({
  controller,
  request,
  unavailableReason,
  disclosure,
}: ReplyPlaybackControlsProps) {
  const { t } = useI18n();
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const state =
    snapshot.status !== "idle" && sameReplyPlaybackIdentity(snapshot.identity, request.identity)
      ? snapshot.status
      : "idle";
  const label =
    state === "loading"
      ? t("Preparing audio")
      : state === "playing"
        ? t("Pause readout")
        : state === "paused"
          ? t("Resume readout")
          : state === "error"
            ? t("Retry readout")
            : t("Read aloud");
  const activate = () => {
    if (state === "playing") controller.pause();
    else if (state === "paused") void controller.resume();
    else if (state === "error") void controller.retry();
    else void controller.start(request);
  };
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1" aria-label={t("Reply playback")}>
      <Button
        aria-label={label}
        aria-busy={state === "loading"}
        title={unavailableReason ?? disclosure ?? label}
        disabled={Boolean(unavailableReason) || state === "loading"}
        size="xs"
        variant="ghost"
        onClick={activate}
      >
        {state === "playing" ? (
          <PauseIcon className="size-3.5" />
        ) : state === "paused" ? (
          <PlayIcon className="size-3.5" />
        ) : (
          <Volume2Icon className="size-3.5" />
        )}
        {label}
      </Button>
      {state === "loading" || state === "playing" || state === "paused" ? (
        <Button
          aria-label={t("Stop readout")}
          size="icon-xs"
          variant="ghost"
          onClick={controller.stop}
        >
          <SquareIcon className="size-3.5" />
        </Button>
      ) : null}
      {state === "error" ? (
        <span role="status" className="text-xs text-muted-foreground">
          {t("Audio could not play. Retry, or check voice settings.")}
        </span>
      ) : null}
      {disclosure ? <span className="text-xs text-muted-foreground">{disclosure}</span> : null}
      {unavailableReason ? (
        <span className="text-xs text-muted-foreground">{unavailableReason}</span>
      ) : null}
    </div>
  );
}
