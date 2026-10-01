import * as Predicate from "effect/Predicate";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";

export type RawMetricAttributes = Readonly<
  Record<string, string | number | boolean | bigint | null | undefined>
>;

export type MetricAttributeValue = string;

export type MetricAttributes = Readonly<Record<string, MetricAttributeValue>>;

export type ObservabilityOutcome = "success" | "failure" | "interrupt";

export function compactMetricAttributes(attributes: RawMetricAttributes): MetricAttributes {
  return Object.fromEntries(
    Object.entries(attributes).flatMap(([key, value]) => {
      if (value === undefined || value === null) {
        return [];
      }

      if (Predicate.isString(value)) {
        return [[key, value]];
      }

      if (Predicate.isNumber(value) || Predicate.isBoolean(value) || Predicate.isBigInt(value)) {
        return [[key, String(value)]];
      }

      return [];
    }),
  );
}

export function outcomeFromExit<A, E>(exit: Exit.Exit<A, E>): ObservabilityOutcome {
  if (Exit.isSuccess(exit)) {
    return "success";
  }

  return Cause.hasInterruptsOnly(exit.cause) ? "interrupt" : "failure";
}

export function normalizeModelMetricLabel(model: string | null | undefined): string | undefined {
  const normalized = model?.trim().toLowerCase();

  if (!normalized) {
    return undefined;
  }

  if (normalized.includes("gpt")) {
    return "gpt";
  }

  if (normalized.includes("claude")) {
    return "claude";
  }

  if (normalized.includes("gemini")) {
    return "gemini";
  }

  return "other";
}
