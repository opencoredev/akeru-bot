import { routineApprovalSummary } from "@t3tools/client-runtime/routines";
import {
  AKERU_CREATE_ROUTINE_TOOL_NAME,
  AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
  type ApprovalRequestId,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
} from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useMobileI18n } from "../../lib/i18n";
import type { PendingApproval } from "../../lib/threadActivity";

export interface PendingApprovalCardProps {
  readonly approval: PendingApproval;
  readonly respondingApprovalId: ApprovalRequestId | null;
  readonly onRespond: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

export function PendingApprovalCard(props: PendingApprovalCardProps) {
  const { t } = useMobileI18n();
  const defaultOptions = [
    { decision: "accept", label: t("Allow once") },
    { decision: "acceptForSession", label: t("Allow session") },
    { decision: "decline", label: t("Decline") },
  ] satisfies ReadonlyArray<ProviderApprovalOption>;
  const feedbackOptions = [
    { decision: "decline", label: t("Cancel") },
  ] satisfies ReadonlyArray<ProviderApprovalOption>;
  const isProductFeedback = props.approval.toolName === AKERU_PRODUCT_FEEDBACK_TOOL_NAME;
  // A routine approval shows what the bot proposes, so it is never approved blind.
  const routine =
    props.approval.toolName === AKERU_CREATE_ROUTINE_TOOL_NAME
      ? routineApprovalSummary(props.approval.args, t)
      : null;
  const options = isProductFeedback ? feedbackOptions : (props.approval.options ?? defaultOptions);
  // Opaque for the same reason as PendingUserInputCard: nothing blurs the feed
  // behind this card, so a translucent surface bleeds messages through it.
  return (
    <View className="gap-2.5 rounded-[20px] border border-neutral-200 bg-neutral-100 p-4 dark:border-white/6 dark:bg-neutral-900">
      <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-sky-700 dark:text-sky-300">
        {t("Approval needed")}
      </Text>
      <Text className="font-t3-bold text-lg text-neutral-950 dark:text-neutral-50">
        {isProductFeedback
          ? t("Product feedback")
          : routine
            ? t("Review routine")
            : (props.approval.appName ?? props.approval.requestKind)}
      </Text>
      {routine ? (
        <View className="gap-1">
          <Text className="font-t3-bold text-base text-neutral-950 dark:text-neutral-50">
            {routine.name}
          </Text>
          {routine.schedule ? (
            <Text className="font-sans text-sm text-neutral-600 dark:text-neutral-400">
              {routine.schedule}
            </Text>
          ) : null}
          {routine.instructions ? (
            <Text className="font-sans text-sm leading-normal text-neutral-600 dark:text-neutral-400">
              {routine.instructions}
            </Text>
          ) : null}
        </View>
      ) : props.approval.detail ? (
        <Text className="font-sans text-sm leading-normal text-neutral-600 dark:text-neutral-400">
          {isProductFeedback
            ? t("Open Akeru Bot on web or desktop to review this feedback draft.")
            : props.approval.detail}
        </Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2.5">
        {options.map((option) => (
          <Pressable
            key={option.decision}
            className={`items-center justify-center rounded-[14px] px-3.5 py-3 ${
              option.decision === "accept"
                ? "bg-blue-500"
                : option.decision === "decline"
                  ? "bg-rose-100 dark:bg-rose-500/18"
                  : "bg-neutral-200 dark:bg-neutral-800"
            }`}
            disabled={props.respondingApprovalId === props.approval.requestId}
            onPress={() => void props.onRespond(props.approval.requestId, option.decision)}
          >
            <Text
              className={`text-sm ${
                option.decision === "accept"
                  ? "font-t3-extrabold text-white"
                  : option.decision === "decline"
                    ? "font-t3-bold text-rose-700 dark:text-rose-300"
                    : "font-t3-bold text-neutral-950 dark:text-neutral-50"
              }`}
            >
              {option.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
