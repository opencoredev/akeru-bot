import type { EnvironmentProject, EnvironmentThreadShell } from "@akeru/client-runtime/state/shell";
import { SymbolView } from "../../components/AppSymbol";
import type { ComponentProps } from "react";
import { Pressable, useWindowDimensions, View } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { AppText as Text } from "../../components/AppText";
import { useMobileI18n } from "../../lib/i18n";
import { relativeTime } from "../../lib/time";
import { useThemeColor } from "../../lib/useThemeColor";
import { ThreadSwipeable } from "../home/thread-swipe-actions";

export function ProjectGroupLabel(props: {
  readonly environmentLabel: string | null;
  readonly project: EnvironmentProject;
}) {
  return (
    <View className="flex-row items-center gap-2.5 px-1 pb-2">
      <Text
        className="flex-1 text-xs font-t3-medium tracking-[0.5px] uppercase text-foreground-muted"
        numberOfLines={1}
      >
        {props.project.title}
      </Text>
      {props.environmentLabel ? (
        <Text className="max-w-[42%] text-2xs text-foreground-tertiary" numberOfLines={1}>
          {props.environmentLabel}
        </Text>
      ) : null}
    </View>
  );
}

export function ArchivedThreadRow(props: {
  readonly environmentLabel: string | null;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly onDelete: () => void;
  readonly onSwipeableClose: (methods: SwipeableMethods) => void;
  readonly onSwipeableWillOpen: (methods: SwipeableMethods) => void;
  readonly simultaneousSwipeGesture?: ComponentProps<
    typeof ThreadSwipeable
  >["simultaneousWithExternalGesture"];
  readonly onUnarchive: () => void;
  readonly thread: EnvironmentThreadShell;
}) {
  const { t } = useMobileI18n();
  const { width: windowWidth } = useWindowDimensions();
  const cardColor = useThemeColor("--color-card");
  const iconColor = useThemeColor("--color-icon-subtle");
  const separatorColor = useThemeColor("--color-separator");
  const timestamp = relativeTime(props.thread.archivedAt ?? props.thread.updatedAt);
  const subtitle = [props.environmentLabel, props.thread.branch].filter((part): part is string =>
    Boolean(part),
  );
  return (
    <ThreadSwipeable
      backgroundColor={cardColor}
      // Round + clip the swipeable container so the group's corners stay
      // rounded while rows swipe; the row itself stays square inside.
      containerStyle={{
        borderTopLeftRadius: props.isFirst ? 20 : 0,
        borderTopRightRadius: props.isFirst ? 20 : 0,
        borderBottomLeftRadius: props.isLast ? 20 : 0,
        borderBottomRightRadius: props.isLast ? 20 : 0,
        overflow: "hidden",
      }}
      fullSwipeWidth={windowWidth - 32}
      onDelete={props.onDelete}
      onSwipeableClose={props.onSwipeableClose}
      onSwipeableWillOpen={props.onSwipeableWillOpen}
      primaryAction={{
        accessibilityLabel: t("Unarchive {title}", { title: props.thread.title }),
        icon: "arrow.uturn.backward",
        label: t("Unarchive"),
        onPress: props.onUnarchive,
      }}
      simultaneousWithExternalGesture={props.simultaneousSwipeGesture}
      threadTitle={props.thread.title}
    >
      {() => (
        <View
          className="flex-row items-center gap-3 bg-card px-4 py-3"
          style={{
            borderBottomColor: separatorColor,
            borderBottomWidth: props.isLast ? 0 : 1,
          }}
        >
          <View className="h-[34px] w-[34px] items-center justify-center rounded-[11px] bg-subtle">
            <SymbolView name="archivebox.fill" size={15} tintColor={iconColor} type="monochrome" />
          </View>

          <View className="min-w-0 flex-1 gap-1">
            <View className="flex-row items-center gap-2">
              <Text
                className="min-w-0 flex-1 text-base font-t3-bold leading-snug text-foreground"
                numberOfLines={1}
              >
                {props.thread.title}
              </Text>
              <Text className="min-w-[30px] text-right text-xs tabular-nums text-foreground-tertiary">
                {timestamp}
              </Text>
            </View>
            {subtitle.length > 0 ? (
              <View className="flex-row items-center gap-1.5">
                <SymbolView
                  name="arrow.triangle.branch"
                  size={10}
                  tintColor={iconColor}
                  type="monochrome"
                />
                <Text
                  className="min-w-0 flex-1 font-mono text-2xs text-foreground-tertiary"
                  numberOfLines={1}
                >
                  {subtitle.join(" · ")}
                </Text>
              </View>
            ) : null}
          </View>
        </View>
      )}
    </ThreadSwipeable>
  );
}

export function ArchiveError(props: { readonly message: string; readonly onRetry: () => void }) {
  const { t } = useMobileI18n();
  return (
    <View className="rounded-[20px] border border-danger-border bg-danger p-4">
      <Text className="text-base font-t3-bold text-danger-foreground">
        {t("Could not load every archive")}
      </Text>
      <Text className="mt-1 text-sm text-foreground-muted">{props.message}</Text>
      <Pressable className="mt-3 self-start active:opacity-60" onPress={props.onRetry}>
        <Text className="text-sm font-t3-bold text-danger-foreground">{t("Try again")}</Text>
      </Pressable>
    </View>
  );
}
