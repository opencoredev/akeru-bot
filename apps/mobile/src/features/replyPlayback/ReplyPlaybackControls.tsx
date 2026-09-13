import { useSyncExternalStore } from "react";
import { Pressable, View } from "react-native";
import {
  sameReplyPlaybackIdentity,
  type ReplyPlaybackController,
  type ReplyPlaybackRequest,
} from "@t3tools/client-runtime/reply-playback";

import { AppText } from "../../components/AppText";

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
      ? "Preparing audio"
      : state === "playing"
        ? "Pause readout"
        : state === "paused"
          ? "Resume readout"
          : state === "error"
            ? "Retry readout"
            : "Read aloud";
  const disabled = Boolean(unavailableReason) || state === "loading";
  const activate = () => {
    if (disabled) return;
    if (state === "playing") controller.pause();
    else if (state === "paused") void controller.resume();
    else if (state === "error") void controller.retry();
    else void controller.start({ ...request, automatic: false });
  };
  return (
    <View className="gap-1">
      <View className="flex-row flex-wrap items-center gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityHint={unavailableReason ?? disclosure}
          accessibilityState={{ disabled, busy: state === "loading" }}
          disabled={disabled}
          onPress={activate}
          className="min-h-11 min-w-11 items-center justify-center rounded-xl bg-subtle px-3"
        >
          <AppText className="text-sm">{label}</AppText>
        </Pressable>
        {state === "loading" || state === "playing" || state === "paused" ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Stop readout"
            onPress={controller.stop}
            className="min-h-11 min-w-11 items-center justify-center rounded-xl bg-subtle px-3"
          >
            <AppText className="text-sm">Stop</AppText>
          </Pressable>
        ) : null}
      </View>
      {state === "error" ? (
        <AppText
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="text-sm text-muted-foreground"
        >
          Audio could not play. Retry, or check voice settings.
        </AppText>
      ) : null}
      {disclosure ? (
        <AppText className="text-sm text-muted-foreground">{disclosure}</AppText>
      ) : null}
      {unavailableReason ? (
        <AppText className="text-sm text-muted-foreground">{unavailableReason}</AppText>
      ) : null}
    </View>
  );
}
