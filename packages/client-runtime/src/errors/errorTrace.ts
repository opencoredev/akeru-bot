import * as Predicate from "effect/Predicate";
import * as Cause from "effect/Cause";

const MAX_ERROR_TRACE_NODES = 128;

export function findErrorTraceId(cause: unknown): string | null {
  const seen = new Set<object>();
  const pending: Array<unknown> = [cause];
  let inspectedNodeCount = 0;

  while (pending.length > 0 && inspectedNodeCount < MAX_ERROR_TRACE_NODES) {
    const current = pending.pop();
    inspectedNodeCount += 1;

    if (
      !(Predicate.isObjectOrArray(current) || current === null) ||
      current === null ||
      seen.has(current)
    ) {
      continue;
    }

    seen.add(current);

    const record = current;

    if (
      Predicate.hasProperty(record, "traceId") &&
      Predicate.isString(record.traceId) &&
      record.traceId.trim().length > 0
    ) {
      return record.traceId;
    }

    if (Predicate.hasProperty(record, "errors") && Array.isArray(record.errors)) {
      for (let index = record.errors.length - 1; index >= 0; index -= 1) {
        pending.push(record.errors[index]);
      }
    }

    if (Cause.isCause(current)) {
      for (let index = current.reasons.length - 1; index >= 0; index -= 1) {
        const reason = current.reasons[index];

        switch (reason?._tag) {
          case "Fail":
            pending.push(reason.error);
            break;
          case "Die":
            pending.push(reason.defect);
            break;
        }
      }
    }

    if ("cause" in record) {
      pending.push(record.cause);
    }
  }

  return null;
}
