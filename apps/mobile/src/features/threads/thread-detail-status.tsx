import { useMobileI18n } from "../../lib/i18n";
import { presentThreadError, type ThreadErrorContext } from "@akeru/client-runtime/errors";
import { Text, View } from "react-native";

export function ResumeErrorSummary(props: {
  readonly error: string | null;
  readonly context: ThreadErrorContext;
}) {
  const { t } = useMobileI18n();
  if (!props.error && !props.context.unavailability) {
    return (
      <Text className="min-w-0 flex-1 text-sm text-foreground">
        {t("The request stopped before it could finish.")}
      </Text>
    );
  }
  const presentation = presentThreadError(props.error ?? "", props.context, t);
  return (
    <View className="min-w-0 flex-1 gap-0.5">
      <Text className="text-sm font-semibold text-foreground">{presentation.title}</Text>
      <Text className="text-sm text-foreground-muted">{presentation.description}</Text>
    </View>
  );
}
