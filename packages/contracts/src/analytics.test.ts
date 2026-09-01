import { describe, expect, it } from "vite-plus/test";

import {
  USAGE_3H_COUNTER_KEYS,
  USAGE_3H_COUNTER_MAX,
  USAGE_BASE_COUNTER_KEYS,
  decodeUsage3hEvent,
} from "./analytics.ts";

const event = {
  event: "usage_3h",
  distinct_id: "0f64da24-2c54-4d2a-9d68-f117c4e78e01",
  properties: {
    app_version: "1.2.3-beta.1+build.4",
    operating_system: "darwin",
    architecture: "arm64",
    client_type: "desktop",
    provider: "mixed",
    sandbox_provider: "local",
    bucket_start: "2026-08-31T18:00:00.000Z",
    new_installations: 1,
    bots_created: 1,
    bots_deleted: 0,
    bots_total: 3,
    user_messages: 2,
    bot_replies: 2,
    failed_turns: 0,
    group_messages: 0,
    external_messages: 0,
    voice_sessions: 0,
    browser_tasks: 0,
    routines_run: 0,
    routine_failures: 0,
    connector_calls: 0,
    connector_failures: 0,
    approvals_requested: 1,
    approvals_accepted: 1,
    approvals_rejected: 0,
    ...Object.fromEntries(
      USAGE_3H_COUNTER_KEYS.slice(USAGE_BASE_COUNTER_KEYS.length).map((key) => [key, 0]),
    ),
    $process_person_profile: false,
    $geoip_disable: true,
    $ip: "0.0.0.0",
    $insert_id: "a".repeat(64),
  },
  timestamp: "2026-08-31T21:00:00.000Z",
} as const;

const rejects = (input: unknown) => expect(() => decodeUsage3hEvent(input)).toThrow();

describe("Usage3hEvent", () => {
  it("accepts the fixed anonymous aggregate payload", () => {
    expect(decodeUsage3hEvent(event)).toEqual(event);
    expect(USAGE_3H_COUNTER_KEYS).toHaveLength(96);
  });

  it("accepts current remote sandboxes and rejects the retired hosted sandbox", () => {
    for (const sandbox_provider of ["e2b", "daytona", "vercel", "upstash"] as const) {
      expect(
        decodeUsage3hEvent({
          ...event,
          properties: { ...event.properties, sandbox_provider },
        }).properties.sandbox_provider,
      ).toBe(sandbox_provider);
    }
    rejects({
      ...event,
      properties: { ...event.properties, sandbox_provider: "akeru-cloud" },
    });
  });

  it("defaults queued events from before install tracking to zero", () => {
    const legacyProperties = Object.fromEntries(
      Object.entries(event.properties).filter(([key]) => key !== "new_installations"),
    );

    expect(
      decodeUsage3hEvent({ ...event, properties: legacyProperties }).properties.new_installations,
    ).toBe(0);
  });

  it("rejects unknown events and properties", () => {
    rejects({ ...event, event: "turn_completed" });
    rejects({ ...event, prompt: "private" });
    rejects({ ...event, properties: { ...event.properties, thread_id: "thread-1" } });
  });

  it("rejects free text, invalid enums, and invalid versions", () => {
    rejects({ ...event, distinct_id: "installation-name" });
    rejects({ ...event, properties: { ...event.properties, provider: "custom-provider" } });
    rejects({ ...event, properties: { ...event.properties, app_version: "v1 latest" } });
    rejects({
      ...event,
      properties: { ...event.properties, app_version: `1.2.3+${"a".repeat(59)}` },
    });
  });

  it("rejects negative, fractional, and oversized counters", () => {
    rejects({ ...event, properties: { ...event.properties, new_installations: 2 } });
    rejects({ ...event, properties: { ...event.properties, failed_turns: -1 } });
    rejects({ ...event, properties: { ...event.properties, bot_replies: 1.5 } });
    rejects({
      ...event,
      properties: { ...event.properties, user_messages: USAGE_3H_COUNTER_MAX + 1 },
    });
  });

  it("rejects invalid buckets, timestamps, and PostHog privacy properties", () => {
    rejects({
      ...event,
      properties: { ...event.properties, bucket_start: "2026-08-31T19:00:00.000Z" },
    });
    rejects({
      ...event,
      properties: { ...event.properties, bucket_start: "2026-02-31T18:00:00.000Z" },
    });
    rejects({ ...event, timestamp: "2026-08-31T20:59:59.999Z" });
    rejects({
      ...event,
      properties: { ...event.properties, $process_person_profile: true },
    });
    rejects({ ...event, properties: { ...event.properties, $geoip_disable: false } });
    rejects({ ...event, properties: { ...event.properties, $ip: "192.0.2.1" } });
    rejects({ ...event, properties: { ...event.properties, $insert_id: "not-a-hash" } });
  });
});
