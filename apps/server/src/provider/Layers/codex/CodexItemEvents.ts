import * as Match from "effect/Match";
import { type ProviderEvent, type ProviderRuntimeEvent, ThreadId } from "@akeru/contracts";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import {
  readPayload,
  toCanonicalItemType,
  itemTitle,
  itemDetail,
} from "./CodexCanonicalMapping.ts";
import { runtimeEventBase } from "./CodexEventIdentity.ts";

export function mapItemLifecycle(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  lifecycle: "item.started" | "item.updated" | "item.completed",
): ProviderRuntimeEvent | undefined {
  const payload =
    readPayload(EffectCodexSchema.V2ItemStartedNotification, event.payload) ??
    readPayload(EffectCodexSchema.V2ItemCompletedNotification, event.payload);

  const item = payload?.item;

  if (!item) {
    return undefined;
  }

  const itemType = toCanonicalItemType(item.type);

  if (itemType === "unknown" && lifecycle !== "item.updated") {
    return undefined;
  }

  const detail = itemDetail(itemType, item);

  const status = Match.value(lifecycle).pipe(
    Match.when("item.started", () => "inProgress" as const),
    Match.when("item.completed", () =>
      "status" in item && (item.status === "failed" || item.status === "declined")
        ? item.status
        : "completed",
    ),
    Match.orElse(() => undefined),
  );

  return {
    ...runtimeEventBase(event, canonicalThreadId),
    type: lifecycle,
    payload: {
      itemType,
      ...(status ? { status } : {}),
      ...(itemTitle(itemType, item) ? { title: itemTitle(itemType, item) } : {}),
      ...(detail ? { detail } : {}),
      ...(event.payload !== undefined ? { data: event.payload } : {}),
    },
  };
}
