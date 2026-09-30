import { describe, expect, it } from "vite-plus/test";

import { delegationSummaryText } from "./delegationSummaryText.ts";

describe("delegationSummaryText", () => {
  it("names the bot and keeps the result as plain text", () => {
    expect(
      delegationSummaryText({
        botName: "Scout",
        task: "Compare **three** flights",
        outcome: {
          _tag: "Completed",
          summary: "## Result\n**Cheapest:** the [9:40 flight](https://example.com/f).\n\n`AB123`",
        },
      }),
    ).toBe(
      'Scout finished "Compare three flights": Result\nCheapest: the 9:40 flight (https://example.com/f).\n\nAB123',
    );
  });

  it("drops italic and list markers but keeps snake_case words", () => {
    expect(
      delegationSummaryText({
        botName: "Scout",
        task: "Check flights",
        outcome: {
          _tag: "Completed",
          summary: "Found *two* options for _you_:\n* flight_a at 9:40\n+ flight_b at 12:10",
        },
      }),
    ).toBe(
      'Scout finished "Check flights": Found two options for you:\n- flight_a at 9:40\n- flight_b at 12:10',
    );
  });

  it("reports a failure without markdown", () => {
    expect(
      delegationSummaryText({
        botName: "Scout",
        task: "Book the hotel",
        outcome: { _tag: "Failed", message: "The site asked for a login." },
      }),
    ).toBe('Scout could not finish "Book the hotel": The site asked for a login.');
  });

  it("shortens long results", () => {
    const text = delegationSummaryText({
      botName: "Scout",
      task: "Summarize",
      outcome: { _tag: "Completed", summary: "x".repeat(50) },
      maxDetailChars: 10,
    });
    expect(text).toBe(`Scout finished "Summarize": ${"x".repeat(10)}…`);
  });
});
