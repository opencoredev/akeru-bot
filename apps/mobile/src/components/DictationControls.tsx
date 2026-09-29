import { useEffect, useRef } from "react";
import { AccessibilityInfo, Platform, Pressable, View } from "react-native";
import { AppText } from "./AppText";
import { SymbolView } from "./AppSymbol";
import { useThemeColor } from "../lib/useThemeColor";

export interface DictationControlsProps {
  status: "idle" | "requesting" | "recording" | "transcribing" | "canceled" | "failed";
  unavailableReason?: string | null;
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
  const holding = useRef(false);
  const holdStartedAt = useRef(0);
  const startedThisGesture = useRef(false);
  const iconColor = useThemeColor("--color-icon");
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
    holding.current = false;
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
  const announcement = unavailableReason
    ? `Dictation unavailable: ${unavailableReason}`
    : announcements[status];

  useEffect(() => {
    // Android uses the live region; iOS needs an explicit announcement.
    if (Platform.OS === "ios") AccessibilityInfo.announceForAccessibility(announcement);
  }, [announcement]);

  const activate = () => {
    if (explainsBlock) {
      onBlockedPress(unavailableReason!);
      return;
    }
    if (disabled || holding.current) return;
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
  const micButton = (
    <View
      accessible
      focusable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Hold to dictate and release to finish, or activate to start and activate again to stop."
      accessibilityState={{ disabled: disabled || explainsBlock, busy: status === "transcribing" }}
      accessibilityActions={[{ name: "activate" }]}
      onAccessibilityTap={activate}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === "activate") activate();
      }}
      onStartShouldSetResponder={() => !disabled}
      onResponderGrant={() => {
        if (explainsBlock) {
          onBlockedPress(unavailableReason!);
          return;
        }
        if (
          disabled ||
          holding.current ||
          (appearance === "send-slot" && status === "transcribing")
        )
          return;
        holding.current = true;
        holdStartedAt.current = Date.now();
        startedThisGesture.current = !active;
        if (!active) start();
      }}
      onResponderRelease={() => {
        if (!holding.current) return;
        holding.current = false;
        // A tap starts recording; only a real hold finishes on release.
        if (
          appearance === "send-slot" &&
          startedThisGesture.current &&
          Date.now() - holdStartedAt.current < 220
        )
          return;
        onRelease();
      }}
      onResponderTerminate={() => {
        if (holding.current) cancel();
      }}
      onResponderTerminationRequest={() => true}
      className={
        appearance === "send-slot"
          ? `h-11 w-11 items-center justify-center rounded-full ${active ? "bg-red-500" : "bg-primary"} ${disabled || explainsBlock ? "opacity-50" : ""}`
          : `min-h-11 items-center justify-center rounded-full bg-subtle px-4 ${disabled ? "opacity-50" : ""}`
      }
    >
      {appearance === "send-slot" ? (
        <SymbolView
          name={status === "transcribing" ? "stop.fill" : retry ? "arrow.clockwise" : "mic.fill"}
          size={18}
          tintColor="white"
          type="monochrome"
        />
      ) : (
        <AppText className="text-sm">{active ? "Stop dictation" : "Dictate"}</AppText>
      )}
    </View>
  );

  if (appearance === "send-slot") {
    if (!active && !retry) return micButton;
    return (
      <View className="flex-row items-center gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={retry ? "Dismiss dictation error" : "Cancel dictation"}
          onPress={retry ? () => cancelCallback.current() : cancel}
          className="h-11 w-11 items-center justify-center rounded-full bg-subtle"
        >
          <SymbolView name="xmark" size={14} tintColor={iconColor} type="monochrome" />
        </Pressable>
        {micButton}
      </View>
    );
  }

  return (
    <View className="gap-2">
      <View className="flex-row items-center gap-2">
        {micButton}
        {busy && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel dictation"
            onPress={cancel}
            className="min-h-11 items-center justify-center rounded-full bg-subtle px-4"
          >
            <AppText className="text-sm">Cancel dictation</AppText>
          </Pressable>
        )}
      </View>
      <AppText className="text-xs text-foreground-muted">
        Hold to dictate, or activate to toggle.
      </AppText>
      <AppText accessibilityLiveRegion="polite" className="text-xs text-foreground-muted">
        {announcement}
      </AppText>
    </View>
  );
}
