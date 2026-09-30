/**
 * Per-bot usage screen.
 *
 * Display parity with web's bot usage section: the same query, the same state
 * semantics, and the same honesty rules. Editing the cap stays in chat settings,
 * so the cap row states where it is changed instead of pretending to be a field.
 *
 * The query does not poll. It reads on arrival, when the app returns to the
 * foreground (`appFocusSignalAtom`), when this screen is focused again, and on
 * pull. A blurred screen and a backgrounded app both cost nothing.
 *
 * @module features/usage/BotUsageRouteScreen
 */
import { useFocusEffect, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { BotId, type EnvironmentId } from "@t3tools/contracts";
import { useCallback, useMemo, useRef } from "react";
import { Platform, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { botUsageEnvironment } from "../../state/botUsage";
import { useEnvironmentQuery } from "../../state/query";
import { BotUsageDetails } from "./BotUsageDetails";
import { botUsageView } from "./botUsagePresentation";

export type BotUsageParams = {
  readonly environmentId: EnvironmentId;
  readonly botId: string;
  readonly botName: string;
} & Record<string, unknown>;

/**
 * Reads again on every focus after the first. The first focus is the mount,
 * whose own read is already in flight; refreshing on top of it would pay for the
 * same answer twice.
 */
function useRefreshOnRefocus(identity: string, refresh: () => void) {
  const focusedIdentity = useRef<string | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (focusedIdentity.current === identity) refresh();
      focusedIdentity.current = identity;
    }, [identity, refresh]),
  );
}

export function BotUsageRouteScreen({ route }: StaticScreenProps<BotUsageParams>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environmentId, botId, botName } = route.params;
  const usageAtom = useMemo(
    () => botUsageEnvironment.summary({ environmentId, input: { botId: BotId.make(botId) } }),
    [botId, environmentId],
  );
  const query = useEnvironmentQuery(usageAtom);
  useRefreshOnRefocus(`${environmentId}:${botId}`, query.refresh);
  const view = botUsageView(query);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title={botName} onBack={() => navigation.goBack()} />
        </>
      ) : (
        <NativeStackScreenOptions options={{ title: botName }} />
      )}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={
          <RefreshControl
            refreshing={query.isPending && query.data !== null}
            onRefresh={query.refresh}
          />
        }
      >
        <BotUsageDetails botName={botName} view={view} />
      </ScrollView>
    </View>
  );
}
